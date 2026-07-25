import type { Candle } from "../types";
import { ema, rsi, sma } from "./index";

/**
 * A small, hand-written, sandboxed expression evaluator for user-authored
 * custom indicators. Deliberately does NOT use `eval`, `new Function`, or any
 * expression-parsing library — it is a real tokenizer + recursive-descent
 * parser + tree-walking evaluator over a tiny, fixed grammar:
 *
 *   expression  := comparison
 *   comparison  := additive (('>' | '<' | '>=' | '<=' | '==' | '!=') additive)*
 *   additive    := multiplicative (('+' | '-') multiplicative)*
 *   multiplicative := unary (('*' | '/') unary)*
 *   unary       := ('+' | '-') unary | primary
 *   primary     := NUMBER | IDENT ('(' args ')')? | '(' expression ')'
 *   args        := expression (',' expression)*
 *
 * Series references (`open`, `high`, `low`, `close`, `volume`) and the fixed
 * helper-function allowlist (`sma`, `ema`, `rsi`, `abs`, `max`, `min`) are the
 * only identifiers the grammar recognizes. Anything else — property access,
 * `window`/`document`/`this`, string/template literals, assignment, statement
 * separators, unknown functions — fails to tokenize or fails to parse with a
 * position-aware error. There is no fallback path: invalid input always
 * throws before any evaluation happens.
 */

// --- Errors -----------------------------------------------------------------

export class FormulaError extends Error {
  readonly position?: number;

  constructor(message: string, position?: number) {
    super(message);
    this.name = "FormulaError";
    this.position = position;
  }
}

// --- Tokenizer ---------------------------------------------------------------

export type TokenType =
  | "NUMBER"
  | "IDENT"
  | "+"
  | "-"
  | "*"
  | "/"
  | "("
  | ")"
  | ","
  | ">"
  | "<"
  | ">="
  | "<="
  | "=="
  | "!="
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const TWO_CHAR_OPERATORS: Record<string, TokenType> = {
  ">=": ">=",
  "<=": "<=",
  "==": "==",
  "!=": "!=",
};

const ONE_CHAR_OPERATORS: Record<string, TokenType> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "(": "(",
  ")": ")",
  ",": ",",
  ">": ">",
  "<": "<",
};

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Tokenizes a formula string. Throws {@link FormulaError} on the first
 * character that cannot start a valid token — this is the first line of
 * sandbox defense: characters like `{ } [ ] ; = " ' \``  simply never become
 * a token, so nothing built from them can ever reach the parser or evaluator. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(input[i + 1] ?? ""))) {
      const start = i;
      let seenDot = false;
      while (i < input.length && (isDigit(input[i]) || (input[i] === "." && !seenDot))) {
        if (input[i] === ".") seenDot = true;
        i++;
      }
      tokens.push({ type: "NUMBER", value: input.slice(start, i), pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < input.length && isIdentPart(input[i])) i++;
      tokens.push({ type: "IDENT", value: input.slice(start, i), pos: start });
      continue;
    }

    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPERATORS[two]) {
      tokens.push({ type: TWO_CHAR_OPERATORS[two], value: two, pos: i });
      i += 2;
      continue;
    }

    if (ONE_CHAR_OPERATORS[ch]) {
      tokens.push({ type: ONE_CHAR_OPERATORS[ch], value: ch, pos: i });
      i++;
      continue;
    }

    throw new FormulaError(`Unexpected character '${ch}' at position ${i}`, i);
  }

  tokens.push({ type: "EOF", value: "", pos: input.length });
  return tokens;
}

// --- AST ---------------------------------------------------------------------

export type SeriesName = "open" | "high" | "low" | "close" | "volume";

export const SERIES_NAMES: ReadonlySet<SeriesName> = new Set([
  "open",
  "high",
  "low",
  "close",
  "volume",
]);

/** Allowed helper functions and their required argument count. */
export const FUNCTION_ARITY: Readonly<Record<string, number>> = {
  sma: 2,
  ema: 2,
  rsi: 2,
  abs: 1,
  max: 2,
  min: 2,
};

const COMPARISON_TYPES = new Set<TokenType>([">", "<", ">=", "<=", "==", "!="]);
const ADDITIVE_TYPES = new Set<TokenType>(["+", "-"]);
const MULTIPLICATIVE_TYPES = new Set<TokenType>(["*", "/"]);

export type FormulaNode =
  | { type: "Number"; value: number; pos: number }
  | { type: "Series"; name: SeriesName; pos: number }
  | { type: "Call"; name: string; args: FormulaNode[]; pos: number }
  | { type: "Binary"; op: TokenType; left: FormulaNode; right: FormulaNode; pos: number }
  | { type: "Unary"; op: "+" | "-"; operand: FormulaNode; pos: number };

function describeToken(tok: Token): string {
  return tok.type === "EOF" ? "end of input" : tok.value;
}

/** Parses a token stream (from {@link tokenize}) into a {@link FormulaNode}
 * tree. Every identifier is checked against the series/function allowlist
 * right here, at parse time — an unknown identifier or function name always
 * fails before evaluation is ever attempted. */
const MAX_PARSE_DEPTH = 200;

export function parse(tokens: Token[]): FormulaNode {
  let pos = 0;
  let depth = 0;

  const peek = (): Token => tokens[pos];
  const advance = (): Token => tokens[pos++];

  /** Guards the two unbounded recursion points (nested parens/calls in
   * parsePrimary, nested unary prefixes in parseUnary) so a pathological
   * formula throws FormulaError instead of overflowing the JS call stack. */
  function guardDepth(atPos: number): void {
    depth += 1;
    if (depth > MAX_PARSE_DEPTH) {
      throw new FormulaError(`Formula is too deeply nested (max ${MAX_PARSE_DEPTH})`, atPos);
    }
  }

  function expect(type: TokenType, expected: string): Token {
    const tok = peek();
    if (tok.type !== type) {
      throw new FormulaError(
        `Expected ${expected} but found '${describeToken(tok)}' at position ${tok.pos}`,
        tok.pos,
      );
    }
    return advance();
  }

  function parseExpression(): FormulaNode {
    return parseComparison();
  }

  function parseComparison(): FormulaNode {
    let left = parseAdditive();
    while (COMPARISON_TYPES.has(peek().type)) {
      const opTok = advance();
      const right = parseAdditive();
      left = { type: "Binary", op: opTok.type, left, right, pos: opTok.pos };
    }
    return left;
  }

  function parseAdditive(): FormulaNode {
    let left = parseMultiplicative();
    while (ADDITIVE_TYPES.has(peek().type)) {
      const opTok = advance();
      const right = parseMultiplicative();
      left = { type: "Binary", op: opTok.type, left, right, pos: opTok.pos };
    }
    return left;
  }

  function parseMultiplicative(): FormulaNode {
    let left = parseUnary();
    while (MULTIPLICATIVE_TYPES.has(peek().type)) {
      const opTok = advance();
      const right = parseUnary();
      left = { type: "Binary", op: opTok.type, left, right, pos: opTok.pos };
    }
    return left;
  }

  function parseUnary(): FormulaNode {
    const tok = peek();
    if (tok.type === "+" || tok.type === "-") {
      guardDepth(tok.pos);
      advance();
      const operand = parseUnary();
      depth -= 1;
      return { type: "Unary", op: tok.type, operand, pos: tok.pos };
    }
    return parsePrimary();
  }

  function parseArgs(): FormulaNode[] {
    const args: FormulaNode[] = [];
    if (peek().type !== ")") {
      args.push(parseExpression());
      while (peek().type === ",") {
        advance();
        args.push(parseExpression());
      }
    }
    return args;
  }

  function parsePrimary(): FormulaNode {
    const tok = peek();

    if (tok.type === "NUMBER") {
      advance();
      return { type: "Number", value: Number(tok.value), pos: tok.pos };
    }

    if (tok.type === "(") {
      guardDepth(tok.pos);
      advance();
      const expr = parseExpression();
      depth -= 1;
      expect(")", "')'");
      return expr;
    }

    if (tok.type === "IDENT") {
      advance();
      if (peek().type === "(") {
        guardDepth(tok.pos);
        advance();
        const args = parseArgs();
        depth -= 1;
        expect(")", "')'");

        const arity = FUNCTION_ARITY[tok.value];
        if (arity === undefined) {
          throw new FormulaError(`Unknown function '${tok.value}' at position ${tok.pos}`, tok.pos);
        }
        if (args.length !== arity) {
          throw new FormulaError(
            `${tok.value}() expects ${arity} argument${arity === 1 ? "" : "s"}, got ${args.length} at position ${tok.pos}`,
            tok.pos,
          );
        }
        return { type: "Call", name: tok.value, args, pos: tok.pos };
      }

      if (!SERIES_NAMES.has(tok.value as SeriesName)) {
        throw new FormulaError(`Unknown identifier '${tok.value}' at position ${tok.pos}`, tok.pos);
      }
      return { type: "Series", name: tok.value as SeriesName, pos: tok.pos };
    }

    throw new FormulaError(`Unexpected token '${describeToken(tok)}' at position ${tok.pos}`, tok.pos);
  }

  const ast = parseExpression();
  const trailing = peek();
  if (trailing.type !== "EOF") {
    throw new FormulaError(
      `Unexpected token '${describeToken(trailing)}' at position ${trailing.pos}`,
      trailing.pos,
    );
  }
  return ast;
}

// --- Evaluation ----------------------------------------------------------------

type Value = { kind: "scalar"; value: number } | { kind: "series"; values: number[] };

function scalar(value: number): Value {
  return { kind: "scalar", value };
}

function seriesValue(values: number[]): Value {
  return { kind: "series", values };
}

function toArray(v: Value, length: number): number[] {
  return v.kind === "series" ? v.values : new Array(length).fill(v.value);
}

function mapValue(v: Value, fn: (x: number) => number): Value {
  return v.kind === "scalar" ? scalar(fn(v.value)) : seriesValue(v.values.map(fn));
}

function combine(a: Value, b: Value, length: number, fn: (x: number, y: number) => number): Value {
  if (a.kind === "scalar" && b.kind === "scalar") return scalar(fn(a.value, b.value));
  const av = toArray(a, length);
  const bv = toArray(b, length);
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) out[i] = fn(av[i], bv[i]);
  return seriesValue(out);
}

const BINARY_OPS: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  ">": (a, b) => (a > b ? 1 : 0),
  "<": (a, b) => (a < b ? 1 : 0),
  ">=": (a, b) => (a >= b ? 1 : 0),
  "<=": (a, b) => (a <= b ? 1 : 0),
  "==": (a, b) => (a === b ? 1 : 0),
  "!=": (a, b) => (a !== b ? 1 : 0),
};

interface EvalContext {
  length: number;
  series: Record<SeriesName, number[]>;
}

/** Wraps a raw number[] as minimal Candle[] (all OHLC fields set to the same
 * value) purely so the existing Candle-based sma/ema/rsi from ./index can be
 * reused verbatim instead of reimplemented — `time` is set to the array
 * index so results can be mapped straight back to positions below. */
function toPseudoCandles(values: number[]): Candle[] {
  return values.map((v, i) => ({ time: i, open: v, high: v, low: v, close: v, volume: v }));
}

/** Re-expands the (possibly shorter, warm-up-trimmed) IndicatorPoint[] that
 * ./index's sma/ema/rsi return back into a full-length number[] aligned by
 * index, with NaN standing in for "not yet defined" — mirrors how those
 * functions already signal "no value yet" by simply omitting a point. */
function fromPoints(length: number, points: { time: number; value: number }[]): number[] {
  const out = new Array<number>(length).fill(NaN);
  for (const p of points) out[p.time] = p.value;
  return out;
}

function smaSeries(values: number[], period: number): number[] {
  return fromPoints(values.length, sma(toPseudoCandles(values), period));
}

function emaSeries(values: number[], period: number): number[] {
  return fromPoints(values.length, ema(toPseudoCandles(values), period));
}

function rsiSeries(values: number[], period: number): number[] {
  return fromPoints(values.length, rsi(toPseudoCandles(values), period));
}

function requirePositiveIntegerPeriod(v: Value, fnName: string): number {
  if (v.kind !== "scalar") {
    throw new FormulaError(`${fnName}() period must be a constant number`);
  }
  if (!Number.isInteger(v.value) || v.value <= 0) {
    throw new FormulaError(`${fnName}() period must be a positive integer`);
  }
  return v.value;
}

function evaluateCall(node: Extract<FormulaNode, { type: "Call" }>, ctx: EvalContext): Value {
  switch (node.name) {
    case "sma": {
      const input = toArray(evaluate(node.args[0], ctx), ctx.length);
      const period = requirePositiveIntegerPeriod(evaluate(node.args[1], ctx), "sma");
      return seriesValue(smaSeries(input, period));
    }
    case "ema": {
      const input = toArray(evaluate(node.args[0], ctx), ctx.length);
      const period = requirePositiveIntegerPeriod(evaluate(node.args[1], ctx), "ema");
      return seriesValue(emaSeries(input, period));
    }
    case "rsi": {
      const input = toArray(evaluate(node.args[0], ctx), ctx.length);
      const period = requirePositiveIntegerPeriod(evaluate(node.args[1], ctx), "rsi");
      return seriesValue(rsiSeries(input, period));
    }
    case "abs": {
      return mapValue(evaluate(node.args[0], ctx), Math.abs);
    }
    case "max": {
      return combine(evaluate(node.args[0], ctx), evaluate(node.args[1], ctx), ctx.length, Math.max);
    }
    case "min": {
      return combine(evaluate(node.args[0], ctx), evaluate(node.args[1], ctx), ctx.length, Math.min);
    }
    default: {
      // Unreachable: parse() only ever produces Call nodes for names present
      // in FUNCTION_ARITY, so this can't be hit from any string that parsed.
      throw new FormulaError(`Unknown function '${node.name}'`);
    }
  }
}

function evaluate(node: FormulaNode, ctx: EvalContext): Value {
  switch (node.type) {
    case "Number":
      return scalar(node.value);
    case "Series":
      return seriesValue(ctx.series[node.name]);
    case "Unary": {
      const v = evaluate(node.operand, ctx);
      return node.op === "-" ? mapValue(v, (x) => -x) : v;
    }
    case "Binary": {
      const left = evaluate(node.left, ctx);
      const right = evaluate(node.right, ctx);
      return combine(left, right, ctx.length, BINARY_OPS[node.op]);
    }
    case "Call":
      return evaluateCall(node, ctx);
  }
}

// --- Public API ----------------------------------------------------------------

export interface FormulaPoint {
  time: number;
  value: number;
}

/**
 * Parses and evaluates a user formula against `candles`, returning one point
 * per candle for which the result is a finite number (warm-up bars before an
 * sma/ema/rsi window is full are simply omitted, matching how the built-in
 * indicators in ./index behave).
 *
 * Throws {@link FormulaError} for any syntax error or disallowed construct —
 * never silently executes a partial or best-effort result.
 */
export function evaluateFormula(formula: string, candles: Candle[]): FormulaPoint[] {
  const tokens = tokenize(formula);
  const ast = parse(tokens);

  if (candles.length === 0) return [];

  const ctx: EvalContext = {
    length: candles.length,
    series: {
      open: candles.map((c) => c.open),
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
      volume: candles.map((c) => c.volume),
    },
  };

  const result = evaluate(ast, ctx);
  const values = toArray(result, ctx.length);

  const out: FormulaPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) out.push({ time: candles[i].time, value: values[i] });
  }
  return out;
}
