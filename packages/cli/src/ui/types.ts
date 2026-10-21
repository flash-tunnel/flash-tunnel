export interface ReadyPayload {
  type: 'ready'
  url: string
  localUrl: string
  hostname?: string
  tunnelId: string
  sessionId: string
  expiresAt?: string
}
