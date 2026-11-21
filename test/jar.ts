import type { Response } from 'supertest';

/**
 * A minimal browser cookie jar for supertest: remembers cookies from
 * `Set-Cookie`, forgets them on `Max-Age=0`, and builds the `Cookie` header.
 */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  /** Apply the `Set-Cookie` headers of a response. Returns the response. */
  absorb(response: Response): Response {
    for (const header of setCookies(response)) {
      const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (attributes.some((a) => a.toLowerCase() === 'max-age=0') || value === '') {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
    return response;
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  set(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  delete(name: string): void {
    this.#cookies.delete(name);
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [name, value] of this.#cookies) copy.set(name, value);
    return copy;
  }
}

/** The raw `Set-Cookie` header values of a response. */
export function setCookies(response: Response): string[] {
  const raw: unknown = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  return typeof raw === 'string' ? [raw] : [];
}
