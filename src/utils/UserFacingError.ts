/** Only locally authored, reviewed business messages may be shown verbatim. */
export class UserFacingError extends Error {
  readonly expected: boolean
  constructor(message: string, options?: { cause?: unknown; expected?: boolean }) {
    super(message, { cause: options?.cause })
    this.name = 'UserFacingError'
    this.expected = options?.expected ?? true
  }
}
