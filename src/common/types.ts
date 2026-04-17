/** Extends the Express Request with the user injected by SupabaseAuthGuard */
export interface AuthenticatedRequest {
  authUser: { id: string }
}
