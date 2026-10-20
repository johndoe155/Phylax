/**
 * Types for deploy/db-hash.mjs.
 *
 * The application, the backup tool, the release gate and the restore drills all derive the backup-receipt hash
 * through this one module, so the signature is declared once here rather than re-inferred at each import.
 */
export declare function databaseHash(url?: string | null): string;
