

export type RunAction = (action: () => Promise<void>) => Promise<void>
