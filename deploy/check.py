#!/usr/bin/env python3
"""Checks the app-store templates in deploy/ against docker-compose.yml and the release setup.

Run from anywhere (needs PyYAML):

    uv run --with pyyaml python deploy/check.py

Exits 1 and lists every problem when something drifted: an env var that docker-compose.yml does
not know, a wrong image name, a port or /data path that disagrees, a missing Unraid field, a chart
or manifest version that is not the VERSION file. It also checks the metrics artefacts: the Grafana
dashboard parses, every metric its queries and the Prometheus rules use is in
deploy/metrics_catalogue.txt, and docs/metrics.md documents every catalogued metric.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy"

# Variables that exist only in the all-in-one image / on the platforms, not in docker-compose.yml.
AIO_ONLY = {"PUID", "PGID", "TZ", "ALLOW_ROOT"}
OWNER = "yavuzakbay"
AIO_IMAGE = "tickerglass"
AIO_PORT = 8080
SERVICE_IMAGES = {"api": "tickerglass-api", "web": "tickerglass-web", "alerts": "tickerglass-alerts"}
SECRETISH = re.compile(r"(SECRET|TOKEN|PASSWORD|API_KEY)$")

errors: list[str] = []


def err(where: str, msg: str) -> None:
    errors.append(f"{where}: {msg}")


def load_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        err(str(path.relative_to(ROOT)), f"cannot parse ({e})")
        return None


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


# ---------------------------------------------------------------------------------- reference data


def env_map(env: Any) -> dict[str, str]:
    """A compose `environment:` (dict or list of NAME=value) as {name: raw value}."""
    if isinstance(env, dict):
        return {str(k): "" if v is None else str(v) for k, v in env.items()}
    out: dict[str, str] = {}
    for item in env or []:
        name, _, value = str(item).partition("=")
        out[name] = value
    return out


def compose_default(raw: str) -> str | None:
    m = re.fullmatch(r"\$\{[A-Z0-9_]+:?-(.*)\}", raw)
    return m.group(1) if m else None


class Reference:
    def __init__(self) -> None:
        compose = load_yaml(ROOT / "docker-compose.yml") or {}
        services = compose.get("services", {})
        self.env: dict[str, dict[str, str]] = {}
        for svc in ("api", "alerts"):
            self.env[svc] = env_map(services.get(svc, {}).get("environment"))
            if not self.env[svc]:
                err("docker-compose.yml", f"service {svc} has no environment")
        self.env["web"] = {}
        self.alerts_mem = services.get("alerts", {}).get("mem_limit")
        self.version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        release = load_yaml(ROOT / ".github/workflows/release.yml") or {}
        try:
            matrix = release["jobs"]["images"]["strategy"]["matrix"]["include"]
            self.release_images = {str(e["image"]) for e in matrix}
        except (KeyError, TypeError):
            self.release_images = set()
            err(".github/workflows/release.yml", "cannot read jobs.images.strategy.matrix.include")

    def default(self, svc: str, name: str) -> str | None:
        raw = self.env.get(svc, {}).get(name)
        return compose_default(raw) if raw is not None else None

    def known(self, svc: str | None, name: str) -> bool:
        if name in AIO_ONLY or name.startswith("TG_"):
            return True
        if svc is None:  # all-in-one: API and alerts share one environment
            return name in self.env["api"] or name in self.env["alerts"]
        return name in self.env[svc]


ref = Reference()


def check_env(where: str, svc: str | None, name: str, value: str | None = None) -> None:
    if not ref.known(svc, name):
        err(where, f"env var {name} is not in docker-compose.yml ({svc or 'api/alerts'})")
        return
    if not value or "$" in value or name in AIO_ONLY or name.startswith("TG_"):
        return
    for s in ([svc] if svc else ["api", "alerts"]):
        default = ref.default(s, name)
        if default and default != value and "|" not in value and name != "ALERTS_INTERNAL_TOKEN":
            err(where, f"{name}={value!r} differs from the docker-compose.yml default {default!r}")


def check_image(where: str, image: str, expected: str, tag: str | None) -> None:
    m = re.fullmatch(r"ghcr\.io/([^/]+)/([^:/]+)(?::(.+))?", image)
    if not m:
        err(where, f"image {image!r} is not ghcr.io/{OWNER}/<name>[:tag]")
        return
    owner, name, found_tag = m.groups()
    if owner != OWNER:
        err(where, f"image owner {owner!r} should be {OWNER!r}")
    if name != expected:
        err(where, f"image {name!r} should be {expected!r}")
    if name not in ref.release_images:
        err(where, f"image {name!r} is not published by release.yml")
    if tag is not None and found_tag != tag:
        err(where, f"image tag {found_tag!r} should be {tag!r}")


def check_mem(where: str, value: str, unit: str) -> None:
    want = ref.alerts_mem
    if want is None:
        return
    want_mb = int(re.sub(r"\D", "", str(want)))
    got_mb = int(re.sub(r"\D", "", str(value)))
    if got_mb != want_mb:
        err(where, f"alerts memory limit {value} differs from docker-compose.yml mem_limit {want}")


# ----------------------------------------------------------------------------------------- Unraid


def check_unraid() -> None:
    path = DEPLOY / "unraid" / "tickerglass.xml"
    where = rel(path)
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as e:
        err(where, f"cannot parse ({e})")
        return
    if root.tag != "Container" or root.get("version") != "2":
        err(where, 'root must be <Container version="2">')
    for tag in (
        "Name", "Repository", "Network", "Support", "Project", "Overview", "Category", "WebUI",
        "Icon", "TemplateURL", "Registry",
    ):  # fmt: skip
        el = root.find(tag)
        if el is None or not (el.text or "").strip():
            err(where, f"missing <{tag}>")
    repo = (root.findtext("Repository") or "").strip()
    check_image(where, repo, AIO_IMAGE, None)
    webui = root.findtext("WebUI") or ""
    if f"[PORT:{AIO_PORT}]" not in webui:
        err(where, f"WebUI must use [PORT:{AIO_PORT}]")
    icon = root.findtext("Icon") or ""
    icon_path = icon.split("/main/", 1)[-1]
    if not (ROOT / icon_path).is_file():
        err(where, f"Icon {icon!r} does not point to a file in the repository")
    seen: dict[str, str] = {}
    for cfg in root.findall("Config"):
        name, target, typ = cfg.get("Name"), cfg.get("Target"), cfg.get("Type")
        if not name or not target or typ not in {"Port", "Path", "Variable"}:
            err(where, f"Config {name!r} needs Name, Target and Type Port/Path/Variable")
            continue
        for attr in ("Default", "Description", "Display", "Required", "Mask"):
            if cfg.get(attr) is None:
                err(where, f"Config {target} missing {attr}")
        if cfg.get("Display") not in {"always", "always-hide", "advanced", "advanced-hide"}:
            err(where, f"Config {target} has an invalid Display")
        if cfg.get("Required") not in {"true", "false"} or cfg.get("Mask") not in {"true", "false"}:
            err(where, f"Config {target}: Required and Mask must be true/false")
        seen[target] = typ
        value = (cfg.text or "").strip()
        if typ == "Variable":
            check_env(where, None, target, value)
            if SECRETISH.search(target) and cfg.get("Mask") != "true":
                err(where, f"Config {target} holds a secret and must have Mask=true")
        elif typ == "Port":
            if target != str(AIO_PORT) or cfg.get("Mode") != "tcp":
                err(where, f"Port must be {AIO_PORT}/tcp")
        elif typ == "Path" and target != "/data":
            err(where, f"Path target {target} should be /data")
    for target, typ in (("8080", "Port"), ("/data", "Path"), ("PUID", "Variable"), ("PGID", "Variable")):
        if seen.get(target) != typ:
            err(where, f"missing {typ} Config for {target}")
    for target, want in (("PUID", "99"), ("PGID", "100")):
        cfg = next((c for c in root.findall("Config") if c.get("Target") == target), None)
        if cfg is not None and (cfg.text or "").strip() != want:
            err(where, f"{target} should default to {want} on Unraid")


# ----------------------------------------------------------------------------------------- CasaOS


def check_casaos() -> None:
    path = DEPLOY / "casaos" / "docker-compose.yml"
    where = rel(path)
    doc = load_yaml(path)
    if not isinstance(doc, dict):
        return
    meta = doc.get("x-casaos") or {}
    services = doc.get("services") or {}
    main = meta.get("main")
    if main not in services:
        err(where, "x-casaos.main must name a service")
        return
    for key in ("architectures", "category", "author", "developer", "icon", "port_map", "title", "tagline"):
        if not meta.get(key):
            err(where, f"x-casaos.{key} missing")
    for key in ("title", "tagline", "description"):
        if key in meta and "en_us" not in (meta[key] or {}):
            err(where, f"x-casaos.{key} needs an en_us entry")
    if str(meta.get("port_map")) != str(AIO_PORT):
        err(where, f"x-casaos.port_map should be {AIO_PORT}")
    svc = services[main]
    check_image(where, str(svc.get("image")), AIO_IMAGE, None)
    env = env_map(svc.get("environment"))
    for name, value in env.items():
        check_env(where, None, name, value)
    ports = svc.get("ports") or []
    if not any(str(p.get("target")) == str(AIO_PORT) for p in ports if isinstance(p, dict)):
        err(where, f"service {main} must publish container port {AIO_PORT}")
    vols = [v for v in svc.get("volumes") or [] if isinstance(v, dict)]
    if not any(v.get("target") == "/data" for v in vols):
        err(where, "service must mount /data")
    for v in vols:
        if v.get("target") == "/data" and not str(v.get("source", "")).startswith("/DATA/AppData/"):
            err(where, "data should live under /DATA/AppData/")
    sx = svc.get("x-casaos") or {}
    described = {e.get("container") for e in sx.get("envs") or []}
    for name in env:
        if name not in described:
            err(where, f"env {name} has no x-casaos description")
    if not sx.get("ports") or not sx.get("volumes"):
        err(where, "service x-casaos needs ports and volumes descriptions")
    limits = (svc.get("deploy") or {}).get("resources", {}).get("limits", {})
    if int(re.sub(r"\D", "", str(limits.get("memory", "0")))) < 1536:
        err(where, "memory limit for the all-in-one image should be at least 1536M")


# ---------------------------------------------------------------------------- multi-container files


def check_services(where: str, services: dict[str, Any], tag: str | None, skip: set[str]) -> None:
    for name, expected in SERVICE_IMAGES.items():
        svc = services.get(name)
        if svc is None:
            err(where, f"service {name} missing")
            continue
        check_image(where, str(svc.get("image")), expected, tag)
        for var, value in env_map(svc.get("environment")).items():
            check_env(f"{where} [{name}]", name, var, value)
    for name in services:
        if name not in SERVICE_IMAGES and name not in skip:
            err(where, f"unexpected service {name}")
    api_env = env_map(services.get("api", {}).get("environment"))
    api_vols = services.get("api", {}).get("volumes") or []
    if not any(str(v).endswith(":/data") for v in api_vols):
        err(where, "api must mount /data")
    db = api_env.get("DATABASE_URL")
    if db and db != ref.default("api", "DATABASE_URL"):
        err(where, f"DATABASE_URL {db!r} differs from the compose default")
    hc = " ".join(map(str, services.get("api", {}).get("healthcheck", {}).get("test", [])))
    if "localhost:8000/api/health/ready" not in hc:
        err(where, "api healthcheck must call localhost:8000/api/health/ready")
    web_env = env_map(services.get("web", {}).get("environment"))
    if not re.fullmatch(r"[\w.-]+:8000", web_env.get("TG_API_UPSTREAM", "")):
        err(where, "web TG_API_UPSTREAM must be <api host>:8000")
    alerts_env = env_map(services.get("alerts", {}).get("environment"))
    if not re.fullmatch(r"http://[\w.-]+:8000", alerts_env.get("API_URL", "")):
        err(where, "alerts API_URL must be http://<api host>:8000")
    if not alerts_env.get("ALERTS_INTERNAL_TOKEN"):
        err(where, "alerts needs ALERTS_INTERNAL_TOKEN (same value as the api)")
    if alerts_env.get("ALERTS_INTERNAL_TOKEN") != api_env.get("ALERTS_INTERNAL_TOKEN"):
        err(where, "api and alerts must share ALERTS_INTERNAL_TOKEN")
    check_mem(where, str(services.get("alerts", {}).get("mem_limit", "")), "m")


def check_truenas() -> None:
    path = DEPLOY / "truenas" / "docker-compose.yaml"
    doc = load_yaml(path)
    if not isinstance(doc, dict):
        return
    where = rel(path)
    check_services(where, doc.get("services") or {}, None, set())
    ports = (doc.get("services") or {}).get("web", {}).get("ports") or []
    if not any(str(p).endswith(":80") for p in ports):
        err(where, "web must publish container port 80")


def check_umbrel() -> None:
    base = DEPLOY / "umbrel"
    store = load_yaml(base / "umbrel-app-store.yml")
    if not isinstance(store, dict) or not store.get("id") or not store.get("name"):
        err("deploy/umbrel/umbrel-app-store.yml", "needs id and name")
        return
    app_dir = base / f"{store['id']}-tickerglass"
    if not app_dir.is_dir():
        err(rel(base), f"app folder must be named <store id>-<app id>: {app_dir.name} not found")
        return
    where_app = rel(app_dir / "umbrel-app.yml")
    app = load_yaml(app_dir / "umbrel-app.yml")
    if isinstance(app, dict):
        for key in (
            "manifestVersion", "id", "category", "name", "version", "icon", "tagline", "description",
            "developer", "website", "repo", "support", "port", "gallery", "path",
            "defaultUsername", "defaultPassword", "submitter",
        ):  # fmt: skip
            if key not in app:
                err(where_app, f"missing {key}")
        if app.get("manifestVersion") != 1:
            err(where_app, "manifestVersion must be 1")
        if app.get("id") != app_dir.name:
            err(where_app, f"id must equal the folder name {app_dir.name}")
        if str(app.get("version")) != ref.version:
            err(where_app, f"version {app.get('version')!r} != VERSION {ref.version!r}")
        if not isinstance(app.get("port"), int):
            err(where_app, "port must be an integer")
        for key in ("defaultUsername", "defaultPassword"):
            if app.get(key) not in ("", None):
                err(where_app, f"{key} must be empty (Umbrel's proxy login protects the app)")
    where = rel(app_dir / "docker-compose.yml")
    doc = load_yaml(app_dir / "docker-compose.yml")
    if not isinstance(doc, dict) or not isinstance(app, dict):
        return
    services = doc.get("services") or {}
    check_services(where, services, ref.version, {"app_proxy"})
    proxy = env_map((services.get("app_proxy") or {}).get("environment"))
    if proxy.get("APP_HOST") != f"{app.get('id')}_web_1":
        err(where, f"app_proxy APP_HOST must be {app.get('id')}_web_1")
    if proxy.get("APP_PORT") != "80":
        err(where, "app_proxy APP_PORT must be 80")
    for svc in ("web", "alerts"):
        values = list(env_map(services.get(svc, {}).get("environment")).values())
        if not any(f"{app.get('id')}_api_1:8000" in v for v in values):
            err(where, f"{svc} must reach the api as {app.get('id')}_api_1:8000")
    api_vols = " ".join(map(str, services.get("api", {}).get("volumes") or []))
    if "${APP_DATA_DIR}" not in api_vols:
        err(where, "api data must live in ${APP_DATA_DIR}")
    # Secrets: each derived on its own in exports.sh (derive_entropy: 64 hex chars), never built
    # from ${APP_SEED} with a prefix (that would make one secret computable from the other).
    if "APP_SEED" in str(doc):
        err(where, "do not build secrets from ${APP_SEED}: derive them in exports.sh")
    exports = app_dir / "exports.sh"
    if not exports.is_file():
        err(rel(exports), "missing (derives AUTH_SECRET and ALERTS_INTERNAL_TOKEN)")
        return
    text = exports.read_text(encoding="utf-8")
    derived = dict(
        re.findall(
            r'^(APP_[A-Z0-9_]+)="?\$\(derive_entropy "\$\{app_entropy_identifier\}-([^"]+)"\)"?\s*$',
            text,
            re.M,
        )
    )
    if len(set(derived.values())) != len(derived) or len(derived) < 2:
        err(rel(exports), "needs one derive_entropy line with a distinct identifier per secret")
    for var, secret in (
        ("AUTH_SECRET", "api"),
        ("ALERTS_INTERNAL_TOKEN", "api"),
        ("ALERTS_INTERNAL_TOKEN", "alerts"),
    ):
        value = env_map(services.get(secret, {}).get("environment")).get(var, "")
        m = re.fullmatch(r"\$\{(APP_[A-Z0-9_]+)\}", value)
        if not m or m.group(1) not in derived:
            err(where, f"{secret}.{var} must be ${{APP_...}} derived in exports.sh, got {value!r}")
    api_env = env_map(services.get("api", {}).get("environment"))
    if api_env.get("AUTH_SECRET") == api_env.get("ALERTS_INTERNAL_TOKEN"):
        err(where, "AUTH_SECRET and ALERTS_INTERNAL_TOKEN must be derived separately")


# -------------------------------------------------------------------------------------------- Helm


def check_helm() -> None:
    chart_dir = DEPLOY / "helm" / "tickerglass"
    chart = load_yaml(chart_dir / "Chart.yaml")
    where = rel(chart_dir / "Chart.yaml")
    if isinstance(chart, dict):
        if chart.get("apiVersion") != "v2":
            err(where, "apiVersion must be v2")
        for key in ("version", "appVersion"):
            if str(chart.get(key)) != ref.version:
                err(where, f"{key} {chart.get(key)!r} != VERSION {ref.version!r}")
    values = load_yaml(chart_dir / "values.yaml")
    where = rel(chart_dir / "values.yaml")
    if not isinstance(values, dict):
        return
    for svc, image in SERVICE_IMAGES.items():
        comp = values.get(svc) or {}
        check_image(where, f"{(comp.get('image') or {}).get('repository')}", image, None)
        for key in ("env", "extraEnv"):
            for var in (comp.get(key) or {}):
                check_env(f"{where} [{svc}.{key}]", svc, var, str((comp.get(key) or {})[var]))
    if (values.get("api") or {}).get("service", {}).get("port") != 8000:
        err(where, "api.service.port must be 8000")
    if (values.get("web") or {}).get("service", {}).get("port") != 80:
        err(where, "web.service.port must be 80")
    mem = ((values.get("alerts") or {}).get("resources") or {}).get("limits", {}).get("memory", "")
    check_mem(where, str(mem), "Mi")
    # Env names that the templates hard-code (and the secret keys).
    for tpl in sorted((chart_dir / "templates").glob("*.yaml")):
        text = tpl.read_text(encoding="utf-8")
        svc = tpl.stem if tpl.stem in SERVICE_IMAGES else None
        names = set(re.findall(r"- name: ([A-Z][A-Z0-9_]+)\s*$", text, re.M))
        names |= set(re.findall(r'"name" "([A-Z][A-Z0-9_]+)"', text))
        for var in sorted(names):
            check_env(rel(tpl), svc, var)
    helpers = (chart_dir / "templates" / "_helpers.tpl").read_text(encoding="utf-8")
    if "/data" not in (chart_dir / "templates" / "api.yaml").read_text(encoding="utf-8"):
        err(rel(chart_dir / "templates" / "api.yaml"), "api must mount /data")
    if "tickerglass.secretEnv" not in helpers:
        err(rel(chart_dir / "templates" / "_helpers.tpl"), "secretEnv helper missing")
    api_tpl = (chart_dir / "templates" / "api.yaml").read_text(encoding="utf-8")
    for probe, path in (
        ("readinessProbe", "/api/health/ready"),
        ("startupProbe", "/api/health/live"),
        ("livenessProbe", "/api/health/live"),
    ):
        if not re.search(rf"{probe}:\s+httpGet:\s+path: {re.escape(path)}\s", api_tpl):
            err(rel(chart_dir / "templates" / "api.yaml"), f"{probe} must call {path}")
    if not isinstance(values.get("metrics"), dict) or values["metrics"].get("enabled") is not False:
        err(where, "metrics.enabled must exist and default to false")


# ---------------------------------------------------------------------- metrics, health, nginx

METRIC_CATALOGUE = DEPLOY / "metrics_catalogue.txt"
DASHBOARD = DEPLOY / "grafana" / "tickerglass.json"
RULES = DEPLOY / "prometheus" / "tickerglass.rules.yml"
PROM_EXAMPLE = DEPLOY / "prometheus" / "prometheus.example.yml"
METRICS_DOC = ROOT / "docs" / "metrics.md"
NGINX_TEMPLATE = ROOT / "docker" / "nginx.conf.template"
SERIES_SUFFIXES = ("_bucket", "_sum", "_count")
# Not TickerGlass metrics: Prometheus' own `up`, and the standard process/python collectors the API
# registers next to its own.
FOREIGN_PREFIXES = ("process_", "python_")
FOREIGN_NAMES = {"up"}
PROMQL_KEYWORDS = {
    "by", "without", "on", "ignoring", "group_left", "group_right", "and", "or", "unless", "bool",
    "offset", "inf", "nan",
}  # fmt: skip


def load_catalogue() -> dict[str, str]:
    """{name: type} from deploy/metrics_catalogue.txt (derived from docs/design/metrics.md section 4)."""
    out: dict[str, str] = {}
    try:
        lines = METRIC_CATALOGUE.read_text(encoding="utf-8").splitlines()
    except OSError as e:
        err(rel(METRIC_CATALOGUE), f"cannot read ({e})")
        return out
    for n, line in enumerate(lines, 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2 or parts[1] not in {"gauge", "counter", "histogram"}:
            err(rel(METRIC_CATALOGUE), f"line {n}: expected '<name> gauge|counter|histogram'")
            continue
        name, kind = parts
        if not re.fullmatch(r"tickerglass_[a-z0-9_]+", name):
            err(rel(METRIC_CATALOGUE), f"line {n}: {name!r} is not a tickerglass_ metric name")
        elif kind == "counter" and not name.endswith("_total"):
            err(rel(METRIC_CATALOGUE), f"line {n}: counter {name} must end in _total")
        elif name in out:
            err(rel(METRIC_CATALOGUE), f"line {n}: {name} listed twice")
        out[name] = kind
    return out


def promql_metric_names(expr: str) -> set[str]:
    """Metric names in a PromQL expression: what is left of identifiers once strings, label
    matchers, ranges, grouping clauses, functions and keywords are removed."""
    s = re.sub(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'', '""', expr)  # strings
    s = re.sub(r"\{[^{}]*\}", " ", s)  # label matchers
    s = re.sub(r"\[[^\]]*\]", " ", s)  # ranges and subqueries
    s = re.sub(r"\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^()]*\)", " ", s)
    names = set()
    for m in re.finditer(r"[A-Za-z_:][A-Za-z0-9_:]*", s):
        word = m.group(0)
        if s[m.end() :].lstrip().startswith("(") or word.lower() in PROMQL_KEYWORDS:
            continue  # a function (or a keyword)
        names.add(word)
    return names


def check_metric_names(where: str, expr: str, known: set[str]) -> None:
    for name in sorted(promql_metric_names(expr)):
        if name in known or name in FOREIGN_NAMES or name.startswith(FOREIGN_PREFIXES):
            continue
        err(where, f"metric {name!r} is not in deploy/metrics_catalogue.txt (expr: {expr.strip()[:80]!r})")


def dashboard_exprs(panels: list[Any]) -> list[str]:
    out: list[str] = []
    for panel in panels:
        if not isinstance(panel, dict):
            continue
        for t in panel.get("targets") or []:
            if isinstance(t, dict) and isinstance(t.get("expr"), str):
                out.append(t["expr"])
        out.extend(dashboard_exprs(panel.get("panels") or []))  # collapsed rows nest panels
    return out


def check_metrics() -> None:
    import json

    catalogue = load_catalogue()
    known = set(catalogue)
    for name, kind in catalogue.items():
        if kind == "histogram":
            known.update(name + suffix for suffix in SERIES_SUFFIXES)
    # Dashboard
    where = rel(DASHBOARD)
    try:
        dash = json.loads(DASHBOARD.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        err(where, f"cannot parse ({e})")
        dash = None
    if isinstance(dash, dict):
        if not isinstance(dash.get("schemaVersion"), int) or dash["schemaVersion"] < 39:
            err(where, "schemaVersion must be an integer >= 39")
        if not any(i.get("name") == "DS_PROMETHEUS" for i in dash.get("__inputs") or []):
            err(where, "__inputs must declare DS_PROMETHEUS so Import asks for the data source")
        exprs = dashboard_exprs(dash.get("panels") or [])
        if not exprs:
            err(where, "no panel has a query")
        for expr in exprs:
            check_metric_names(where, expr, known)
        if "${DS_PROMETHEUS}" not in DASHBOARD.read_text(encoding="utf-8"):
            err(where, "panels must use the ${DS_PROMETHEUS} data source")
    # Prometheus rules and example config
    where = rel(RULES)
    rules = load_yaml(RULES)
    if isinstance(rules, dict):
        found = 0
        for group in rules.get("groups") or []:
            for rule in group.get("rules") or []:
                if "expr" in rule:
                    found += 1
                    check_metric_names(f"{where} [{rule.get('alert') or rule.get('record')}]", str(rule["expr"]), known)
        if not found:
            err(where, "no rules with an expr")
    prom = load_yaml(PROM_EXAMPLE)
    if isinstance(prom, dict):
        jobs = prom.get("scrape_configs") or []
        if not any(j.get("job_name") == "tickerglass" and j.get("metrics_path") == "/metrics" for j in jobs):
            err(rel(PROM_EXAMPLE), "needs a scrape job tickerglass with metrics_path /metrics")
        if "tickerglass.rules.yml" not in (prom.get("rule_files") or []):
            err(rel(PROM_EXAMPLE), "rule_files must list tickerglass.rules.yml")
    # The user guide lists every metric
    try:
        doc = METRICS_DOC.read_text(encoding="utf-8")
    except OSError as e:
        err(rel(METRICS_DOC), f"cannot read ({e})")
        doc = ""
    for name in catalogue:
        if doc and name not in doc:
            err(rel(METRICS_DOC), f"metric {name} is not documented")
    # nginx: /metrics must reach the API (the same template renders the web and all-in-one images)
    try:
        nginx = NGINX_TEMPLATE.read_text(encoding="utf-8")
    except OSError as e:
        err(rel(NGINX_TEMPLATE), f"cannot read ({e})")
        nginx = ""
    if not re.search(r"location = /metrics \{[^}]*proxy_pass http://\$\{TG_API_UPSTREAM\};", nginx):
        err(rel(NGINX_TEMPLATE), "needs `location = /metrics` proxied to ${TG_API_UPSTREAM}")
    if "map $http_x_forwarded_proto $tg_forwarded_proto" not in nginx:
        err(rel(NGINX_TEMPLATE), "the $tg_forwarded_proto map is missing")
    aio = (ROOT / "docker" / "aio.Dockerfile").read_text(encoding="utf-8")
    if "/api/health/ready" not in aio:
        err("docker/aio.Dockerfile", "HEALTHCHECK must call /api/health/ready")


def main() -> int:
    check_unraid()
    check_casaos()
    check_truenas()
    check_umbrel()
    check_helm()
    check_metrics()
    if errors:
        print(f"deploy/check.py: {len(errors)} problem(s)", file=sys.stderr)
        for line in errors:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print("deploy/check.py: all templates consistent with docker-compose.yml and VERSION")
    return 0


if __name__ == "__main__":
    sys.exit(main())
