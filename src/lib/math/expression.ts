/**
 * A hand-written expression evaluator.
 *
 * `eval` and `new Function` are not options: the expression comes from a model
 * that was influenced by text fetched off the open web. This is a recursive-descent
 * parser over a closed grammar, so the worst a hostile expression can do is fail
 * to parse. There is no property access, no identifier resolution against the
 * host scope, and no unbounded exponentiation.
 */

export class ExpressionError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = 'ExpressionError';
  }
}

type TokenType = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly position: number;
}

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '^']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i] as string;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      let seenDot = false;
      while (j < input.length) {
        const c = input[j] as string;
        if (c === '.') {
          if (seenDot) break;
          seenDot = true;
          j += 1;
          continue;
        }
        if (!/[0-9]/.test(c)) break;
        j += 1;
      }
      // Scientific notation: 1e6, 2.5E-3
      if (j < input.length && /[eE]/.test(input[j] as string)) {
        let k = j + 1;
        if (k < input.length && /[+-]/.test(input[k] as string)) k += 1;
        if (k < input.length && /[0-9]/.test(input[k] as string)) {
          while (k < input.length && /[0-9]/.test(input[k] as string)) k += 1;
          j = k;
        }
      }
      const raw = input.slice(i, j);
      if (!Number.isFinite(Number(raw))) {
        throw new ExpressionError(`"${raw}" is not a valid number`, i);
      }
      tokens.push({ type: 'number', value: raw, position: i });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      let j = i;
      while (j < input.length && /[a-zA-Z_0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ type: 'identifier', value: input.slice(i, j).toLowerCase(), position: i });
      i = j;
      continue;
    }
    if (OPERATOR_CHARS.has(char)) {
      // Accept "**" as an alias for "^".
      if (char === '*' && input[i + 1] === '*') {
        tokens.push({ type: 'operator', value: '^', position: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'operator', value: char, position: i });
      i += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen', value: char, position: i });
      i += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: char, position: i });
      i += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'comma', value: char, position: i });
      i += 1;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${char}"`, i);
  }
  return tokens;
}

const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

type Fn = (args: number[]) => number;

const FUNCTIONS: Readonly<Record<string, { arity: number | 'variadic'; fn: Fn }>> = {
  sqrt: { arity: 1, fn: ([x]) => Math.sqrt(x as number) },
  abs: { arity: 1, fn: ([x]) => Math.abs(x as number) },
  floor: { arity: 1, fn: ([x]) => Math.floor(x as number) },
  ceil: { arity: 1, fn: ([x]) => Math.ceil(x as number) },
  round: { arity: 1, fn: ([x]) => Math.round(x as number) },
  ln: { arity: 1, fn: ([x]) => Math.log(x as number) },
  log: { arity: 1, fn: ([x]) => Math.log10(x as number) },
  log2: { arity: 1, fn: ([x]) => Math.log2(x as number) },
  exp: { arity: 1, fn: ([x]) => Math.exp(x as number) },
  sin: { arity: 1, fn: ([x]) => Math.sin(x as number) },
  cos: { arity: 1, fn: ([x]) => Math.cos(x as number) },
  tan: { arity: 1, fn: ([x]) => Math.tan(x as number) },
  sign: { arity: 1, fn: ([x]) => Math.sign(x as number) },
  min: { arity: 'variadic', fn: (xs) => Math.min(...xs) },
  max: { arity: 'variadic', fn: (xs) => Math.max(...xs) },
  pow: { arity: 2, fn: ([a, b]) => guardedPow(a as number, b as number) },
};

/**
 * `9^9^9` is a one-line denial of service in a naive calculator. Cap the
 * exponent magnitude and the operand size before doing the work.
 */
const MAX_EXPONENT = 1024;
function guardedPow(base: number, exponent: number): number {
  if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new ExpressionError(
      `Exponent ${exponent} is outside the supported range (+/-${MAX_EXPONENT})`,
      0,
    );
  }
  return base ** exponent;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number {
    const value = this.parseExpression(0);
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as Token;
      throw new ExpressionError(`Unexpected "${token.value}"`, token.position);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  /** Precedence-climbing. Higher binds tighter; `^` is right-associative. */
  private parseExpression(minPrecedence: number): number {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'operator') break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index += 1;
      const rightAssociative = token.value === '^';
      const right = this.parseExpression(rightAssociative ? precedence : precedence + 1);
      left = applyOperator(token, left, right);
    }
    return left;
  }

  private parseUnary(): number {
    const token = this.peek();
    if (token && token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      this.index += 1;
      const value = this.parseUnary();
      return token.value === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (!token) throw new ExpressionError('Expression ended unexpectedly', 0);

    if (token.type === 'number') {
      this.index += 1;
      return Number(token.value);
    }

    if (token.type === 'lparen') {
      this.index += 1;
      const value = this.parseExpression(0);
      const close = this.peek();
      if (!close || close.type !== 'rparen') {
        throw new ExpressionError('Missing closing parenthesis', token.position);
      }
      this.index += 1;
      return value;
    }

    if (token.type === 'identifier') {
      this.index += 1;
      const next = this.peek();
      if (next && next.type === 'lparen') {
        this.index += 1;
        const args: number[] = [];
        if (this.peek()?.type !== 'rparen') {
          for (;;) {
            args.push(this.parseExpression(0));
            const separator = this.peek();
            if (separator && separator.type === 'comma') {
              this.index += 1;
              continue;
            }
            break;
          }
        }
        const close = this.peek();
        if (!close || close.type !== 'rparen') {
          throw new ExpressionError(`Missing ")" after ${token.value}(`, token.position);
        }
        this.index += 1;
        const fn = FUNCTIONS[token.value];
        if (!fn) {
          throw new ExpressionError(`Unknown function "${token.value}"`, token.position);
        }
        if (fn.arity !== 'variadic' && args.length !== fn.arity) {
          throw new ExpressionError(
            `${token.value}() takes ${fn.arity} argument(s), got ${args.length}`,
            token.position,
          );
        }
        if (fn.arity === 'variadic' && args.length === 0) {
          throw new ExpressionError(`${token.value}() needs at least one argument`, token.position);
        }
        return fn.fn(args);
      }
      const constant = CONSTANTS[token.value];
      if (constant === undefined) {
        throw new ExpressionError(`Unknown name "${token.value}"`, token.position);
      }
      return constant;
    }

    throw new ExpressionError(`Unexpected "${token.value}"`, token.position);
  }
}

const PRECEDENCE: Readonly<Record<string, number>> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  '^': 3,
};

function applyOperator(token: Token, left: number, right: number): number {
  switch (token.value) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new ExpressionError('Division by zero', token.position);
      return left / right;
    case '%':
      if (right === 0) throw new ExpressionError('Modulo by zero', token.position);
      return left % right;
    case '^':
      return guardedPow(left, right);
    default:
      throw new ExpressionError(`Unsupported operator "${token.value}"`, token.position);
  }
}

/** Evaluate an arithmetic expression. Throws `ExpressionError` on bad input. */
export function evaluateExpression(input: string): number {
  const value = new Parser(tokenize(input)).parse();
  if (!Number.isFinite(value)) {
    throw new ExpressionError(
      value === Infinity || value === -Infinity
        ? 'Result overflowed to infinity'
        : 'Result is not a number',
      0,
    );
  }
  return value;
}
