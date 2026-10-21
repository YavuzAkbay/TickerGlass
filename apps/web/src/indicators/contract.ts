// Compile-time guard: the indicators package's resolved output metadata must
// stay assignable to the engine's study output metadata (the two packages do
// not import each other). Breaks `pnpm typecheck` if they drift apart.
import type { ResolvedOutput } from '@tickerglass/indicators';
import type { StudyOutputMeta } from '@tickerglass/engine';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

export type _ResolvedOutputIsStudyOutput = Assert<Extends<ResolvedOutput, StudyOutputMeta>>;
