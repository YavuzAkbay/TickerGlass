"""Formula (custom expression) rules of the screener (docs/design/server-screener.md §10).

A formula is a small arithmetic expression over numeric field ids, e.g. `last / sma200 - 1` or
`max(abs(chg1d), gapPct)`. This module turns its text into an AST with a hand-written tokenizer
and recursive-descent parser (no `eval`, no Python `ast`) and compiles the AST to a SQLAlchemy
Core expression: identifiers resolve only to columns of the `fields.FIELDS` whitelist, every
literal becomes a bound parameter. Nothing here builds SQL text.

Grammar (EBNF; ASCII only, whitespace = space, tab, CR, LF)::

    formula = expr ;
    expr    = term , { ( "+" | "-" ) , term } ;
    term    = unary , { ( "*" | "/" ) , unary } ;
    unary   = "-" , unary | primary ;
    primary = number | field | call | "(" , expr , ")" ;
    call    = ( "abs" | "min" | "max" ) , "(" , expr , { "," , expr } , ")"
            | "prev" , "(" , field , ")" ;
    number  = digit , { digit } , [ "." , digit , { digit } ] | "." , digit , { digit } ;
    field   = ( letter | "_" ) , { letter | digit | "_" } ;

`abs` takes 1 argument, `min`/`max` 2-8; `prev(f)` is the previous session's value of a crossable
field. Division by zero yields NULL and NULLs propagate, so such rows never match.

The web client mirrors this parser in `apps/web/src/screener/rules/formula.ts`; both run the
shared vectors in `api/tests/data/formula_vectors.json` and must report the same error code at
the same character offset.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import ColumnElement, Float, bindparam, case, cast, func, null, or_
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.compiler import SQLCompiler
from sqlalchemy.sql.functions import FunctionElement

from .fields import FieldSpec

#: Limits (design §10). Lengths count characters (code points).
MAX_LENGTH = 200
MAX_NODES = 64
MAX_DEPTH = 16
MAX_NUMBER_CHARS = 24
MAX_ARGS = 8
#: `min`/`max` may nest this deep (PostgreSQL renders each argument twice per level).
MAX_MINMAX_NESTING = 2
#: Formula rules per request (they also count toward `schemas.MAX_RULES`).
MAX_FORMULA_RULES = 10
#: `fields` entries of the form `"=<formula>"` per request.
MAX_FORMULA_FIELDS = 3
#: Prefix of a requested field that is a formula column.
FIELD_PREFIX = "="

FORMULA_OPS = (">", "<", ">=", "<=", "between")
#: Field types a formula may reference.
NUMERIC_TYPES = ("number", "percent", "money", "int")
FUNCTIONS: dict[str, tuple[int, int]] = {
    "abs": (1, 1),
    "min": (2, MAX_ARGS),
    "max": (2, MAX_ARGS),
    "prev": (1, 1),
}

ErrorCode = Literal["bad_formula", "unknown_field", "field_unavailable", "too_complex"]


class FormulaError(Exception):
    """A formula that does not parse or exceeds a limit; `offset` is the 0-based character
    position of the problem (the formula's length for an unexpected end)."""

    def __init__(self, code: ErrorCode, message: str, offset: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.offset = offset


# --------------------------------------------------------------------- AST


@dataclass(frozen=True)
class Num:
    text: str
    value: float
    offset: int


@dataclass(frozen=True)
class Ref:
    spec: FieldSpec
    prev: bool
    offset: int


@dataclass(frozen=True)
class Neg:
    operand: "Node"
    offset: int


@dataclass(frozen=True)
class Bin:
    op: str
    left: "Node"
    right: "Node"
    offset: int


@dataclass(frozen=True)
class Call:
    name: str
    args: tuple["Node", ...]
    offset: int


Node = Num | Ref | Neg | Bin | Call


def sexpr(node: Node) -> str:
    """Canonical prefix form, e.g. `(- (/ last sma200) 1)` (shared test vectors)."""
    if isinstance(node, Num):
        return node.text
    if isinstance(node, Ref):
        return f"(prev {node.spec.id})" if node.prev else node.spec.id
    if isinstance(node, Neg):
        return f"(neg {sexpr(node.operand)})"
    if isinstance(node, Bin):
        return f"({node.op} {sexpr(node.left)} {sexpr(node.right)})"
    return f"({node.name} {' '.join(sexpr(a) for a in node.args)})"


def references_fundamentals(node: Node) -> bool:
    if isinstance(node, Ref):
        return node.spec.fundamental
    if isinstance(node, Neg):
        return references_fundamentals(node.operand)
    if isinstance(node, Bin):
        return references_fundamentals(node.left) or references_fundamentals(node.right)
    if isinstance(node, Call):
        return any(references_fundamentals(a) for a in node.args)
    return False


# --------------------------------------------------------------- tokenizer

_PUNCT = "+-*/(),"
_SPACE = " \t\r\n"


def _digit(c: str) -> bool:
    return "0" <= c <= "9"


def _ident_start(c: str) -> bool:
    return "a" <= c <= "z" or "A" <= c <= "Z" or c == "_"


def _ident_char(c: str) -> bool:
    return _ident_start(c) or _digit(c)


@dataclass(frozen=True)
class _Tok:
    kind: Literal["num", "ident", "punct", "end"]
    text: str
    offset: int


def _tokenize(text: str) -> list[_Tok]:
    out: list[_Tok] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in _SPACE:
            i += 1
        elif _digit(c) or (c == "." and i + 1 < n and _digit(text[i + 1])):
            start = i
            while i < n and _digit(text[i]):
                i += 1
            if i + 1 < n and text[i] == "." and _digit(text[i + 1]):
                i += 1
                while i < n and _digit(text[i]):
                    i += 1
            if i - start > MAX_NUMBER_CHARS:
                raise FormulaError("bad_formula", "number too long", start)
            out.append(_Tok("num", text[start:i], start))
        elif _ident_start(c):
            start = i
            while i < n and _ident_char(text[i]):
                i += 1
            out.append(_Tok("ident", text[start:i], start))
        elif c in _PUNCT:
            out.append(_Tok("punct", c, i))
            i += 1
        else:
            raise FormulaError("bad_formula", "unexpected character", i)
    out.append(_Tok("end", "", n))
    return out


# ------------------------------------------------------------------ parser


class _Parser:
    def __init__(self, text: str, fields: Mapping[str, FieldSpec], fundamentals: bool) -> None:
        self.toks = _tokenize(text)
        self.pos = 0
        self.fields = fields
        self.fundamentals = fundamentals
        self.nodes = 0
        self.nesting = 0
        self.minmax = 0

    # tokens
    def peek(self) -> _Tok:
        return self.toks[self.pos]

    def next(self) -> _Tok:
        tok = self.toks[self.pos]
        if tok.kind != "end":
            self.pos += 1
        return tok

    def at(self, *punct: str) -> bool:
        tok = self.peek()
        return tok.kind == "punct" and tok.text in punct

    def expect_close(self) -> None:
        tok = self.next()
        if not (tok.kind == "punct" and tok.text == ")"):
            raise FormulaError("bad_formula", "expected ')'", tok.offset)

    # limits
    def enter(self, offset: int) -> None:
        self.nesting += 1
        if self.nesting > MAX_DEPTH:
            raise FormulaError("too_complex", f"nested more than {MAX_DEPTH} deep", offset)

    def leave(self) -> None:
        self.nesting -= 1

    def make(self, node: Node, depth: int) -> tuple[Node, int]:
        self.nodes += 1
        if self.nodes > MAX_NODES:
            raise FormulaError("too_complex", f"more than {MAX_NODES} terms", node.offset)
        if depth > MAX_DEPTH:
            raise FormulaError("too_complex", f"nested more than {MAX_DEPTH} deep", node.offset)
        return node, depth

    # grammar
    def formula(self) -> Node:
        if self.peek().kind == "end":
            raise FormulaError("bad_formula", "empty formula", self.peek().offset)
        node, _ = self.expr()
        tok = self.peek()
        if tok.kind != "end":
            raise FormulaError("bad_formula", f"unexpected {tok.text!r}", tok.offset)
        return node

    def expr(self) -> tuple[Node, int]:
        left, ld = self.term()
        while self.at("+", "-"):
            op = self.next()
            right, rd = self.term()
            left, ld = self.make(Bin(op.text, left, right, op.offset), 1 + max(ld, rd))
        return left, ld

    def term(self) -> tuple[Node, int]:
        left, ld = self.unary()
        while self.at("*", "/"):
            op = self.next()
            right, rd = self.unary()
            left, ld = self.make(Bin(op.text, left, right, op.offset), 1 + max(ld, rd))
        return left, ld

    def unary(self) -> tuple[Node, int]:
        if self.at("-"):
            tok = self.next()
            self.enter(tok.offset)
            operand, d = self.unary()
            self.leave()
            return self.make(Neg(operand, tok.offset), 1 + d)
        return self.primary()

    def primary(self) -> tuple[Node, int]:
        tok = self.next()
        if tok.kind == "num":
            return self.make(Num(tok.text, float(tok.text), tok.offset), 1)
        if tok.kind == "ident":
            if self.at("("):
                return self.call(tok)
            return self.make(self.ref(tok, prev=False), 1)
        if tok.kind == "punct" and tok.text == "(":
            self.enter(tok.offset)
            inner = self.expr()
            self.expect_close()
            self.leave()
            return inner
        if tok.kind == "end":
            raise FormulaError("bad_formula", "unexpected end of formula", tok.offset)
        raise FormulaError("bad_formula", f"unexpected {tok.text!r}", tok.offset)

    def call(self, name: _Tok) -> tuple[Node, int]:
        bounds = FUNCTIONS.get(name.text)
        if bounds is None:
            raise FormulaError("bad_formula", f"unknown function {name.text!r}", name.offset)
        self.next()  # "("
        self.enter(name.offset)
        if name.text == "prev":
            arg = self.next()
            if arg.kind != "ident" or not self.at(")"):
                raise FormulaError("bad_formula", "prev() takes one field", arg.offset)
            ref = self.ref(arg, prev=True)
            self.expect_close()
            self.leave()
            return self.make(ref, 1)
        minmax = name.text in ("min", "max")
        if minmax:
            self.minmax += 1
            if self.minmax > MAX_MINMAX_NESTING:
                raise FormulaError(
                    "too_complex", f"min/max nest at most {MAX_MINMAX_NESTING} deep", name.offset
                )
        lo, hi = bounds
        first, depth = self.expr()
        args: list[Node] = [first]
        while self.at(","):
            comma = self.next()
            if len(args) >= hi:
                raise FormulaError(
                    "bad_formula", f"{name.text}() takes at most {hi} arguments", comma.offset
                )
            node, d = self.expr()
            args.append(node)
            depth = max(depth, d)
        self.expect_close()
        if len(args) < lo:
            raise FormulaError(
                "bad_formula", f"{name.text}() takes at least {lo} arguments", name.offset
            )
        if minmax:
            self.minmax -= 1
        self.leave()
        return self.make(Call(name.text, tuple(args), name.offset), 1 + depth)

    def ref(self, tok: _Tok, *, prev: bool) -> Ref:
        spec = self.fields.get(tok.text)
        if spec is None:
            raise FormulaError("unknown_field", f"unknown field {tok.text!r}", tok.offset)
        if spec.type not in NUMERIC_TYPES:
            raise FormulaError("bad_formula", f"{spec.id} is not a numeric field", tok.offset)
        if prev and spec.prev_column is None:
            raise FormulaError("bad_formula", f"{spec.id} has no previous value", tok.offset)
        if spec.fundamental and not self.fundamentals:
            raise FormulaError(
                "field_unavailable", f"{spec.id} is not available from this data source", tok.offset
            )
        return Ref(spec, prev, tok.offset)


def parse(text: str, fields: Mapping[str, FieldSpec], *, fundamentals: bool = True) -> Node:
    """The AST of a formula. Raises `FormulaError`."""
    if len(text) > MAX_LENGTH:
        raise FormulaError("too_complex", f"at most {MAX_LENGTH} characters", MAX_LENGTH)
    return _Parser(text, fields, fundamentals).formula()


# ---------------------------------------------------------------- compiler


class _Least(FunctionElement[Any]):
    """`min` of 2+ values, NULL when any value is NULL (see `_extreme`)."""

    type = Float()
    inherit_cache = True


class _Greatest(FunctionElement[Any]):
    """`max` of 2+ values, NULL when any value is NULL (see `_extreme`)."""

    type = Float()
    inherit_cache = True


@compiles(_Least)
@compiles(_Greatest)
def _extreme(element: _Least | _Greatest, compiler: SQLCompiler, **kw: Any) -> str:
    # LEAST/GREATEST (PostgreSQL) skip NULLs, so a NULL argument is checked explicitly.
    args = list(element.clauses)
    fn = func.least if isinstance(element, _Least) else func.greatest
    guarded = case((or_(*(a.is_(None) for a in args)), null()), else_=fn(*args))
    return compiler.process(guarded, **kw)


@compiles(_Least, "sqlite")
@compiles(_Greatest, "sqlite")
def _extreme_sqlite(element: _Least | _Greatest, compiler: SQLCompiler, **kw: Any) -> str:
    # SQLite's multi-argument scalar min()/max() return NULL when any argument is NULL.
    fn = func.min if isinstance(element, _Least) else func.max
    return compiler.process(fn(*element.clauses), **kw)


def compile_node(node: Node, *, fundamentals: bool = True) -> ColumnElement[Any]:
    """SQL expression of a parsed formula (float valued; NULL on a zero divisor or a NULL
    operand). `fundamentals=False` turns fundamental fields into NULL (output columns)."""
    if isinstance(node, Num):
        return bindparam(None, node.value, type_=Float)
    if isinstance(node, Ref):
        if node.spec.fundamental and not fundamentals:
            return null()
        col = node.spec.prev_column if node.prev else node.spec.column
        assert col is not None  # the parser only accepts prev() of crossable fields
        # Integer fields as floats: true division everywhere, no integer overflow.
        return cast(col, Float) if node.spec.type == "int" else col
    if isinstance(node, Neg):
        return -compile_node(node.operand, fundamentals=fundamentals)
    if isinstance(node, Bin):
        a = compile_node(node.left, fundamentals=fundamentals)
        b = compile_node(node.right, fundamentals=fundamentals)
        if node.op == "+":
            return a + b
        if node.op == "-":
            return a - b
        if node.op == "*":
            return a * b
        return cast(a, Float) / func.nullif(b, bindparam(None, 0.0, type_=Float), type_=Float)
    args = [compile_node(a, fundamentals=fundamentals) for a in node.args]
    if node.name == "abs":
        return func.abs(args[0])
    return _Least(*args) if node.name == "min" else _Greatest(*args)
