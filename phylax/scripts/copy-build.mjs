/**
 * Put a production build where the API server will serve it.
 *
 * The app is deployed SAME-ORIGIN with its API: Express serves `dist/public` (or `server/public`) and `/api` on one
 * address, which is what the session cookie, the CSRF double-submit and the server's `requireSameOrigin` check all
 * assume. There is no separate static host any more — `vercel.json` and the shell `server/index.ts` that used to publish
 * `dist/public` are gone, because either of them serving the files would have put the page on an origin the API had not
 * been told about, and every mutating request would have been refused with `cross_origin`.
 *
 * So the build is copied into the backend's `dist/public`. Nothing is transformed on the way: the backend hashes the
 * inline scripts in that exact file at boot to build its Content-Security-Policy, so a build that is edited after the
 * fact would break its own policy.
 *
 * Usage:
 *   node scripts/copy-build.mjs                 # ../phylax-backend/dist/public
 *   PHYLAX_STATIC_DIR=/srv/phylax/dist/public node scripts/copy-build.mjs
 */
import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const source = path.resolve(here, "..", "dist", "public");
const target = path.resolve(process.env.PHYLAX_STATIC_DIR ?? path.join(here, "..", "..", "phylax-backend", "dist", "public"));

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(path.join(source, "index.html")))) {
  console.error(`No build at ${source}. Run \`npm run build\` first.`);
  process.exit(1);
}

// A stale asset from an earlier build would stay in the target and be served with the new index.html's URLs, so the
// directory is replaced rather than merged.
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Copied ${source} -> ${target}`);
