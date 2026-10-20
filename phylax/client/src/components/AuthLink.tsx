import { useAuth } from "@/hooks/useAuth";

const LOGIN_URL = "/login";
const DASHBOARD_URL = "/dashboard";
const LOGIN_LABEL = "Log in";
const DASHBOARD_LABEL = "Dashboard";

interface AuthLinkProps {
  /** The classes of the original button. Both states use them unchanged, so size, type and variant never differ. */
  className?: string;
  /** Render a non-focusable <span> instead of a link, for the hero's inverted twin (it sits in an aria-hidden layer). */
  decorative?: boolean;
}

/**
 * The "Log in" button that becomes "Dashboard" once someone is signed in. It is used in the hero, the menu panel and
 * the footer, and all of them read the same state through useAuth, so they flip together.
 *
 * Layout shift: while the session is still being read (`loading`) it renders the logged-out button, same element and
 * same classes, but `visibility: hidden` (see .auth-link[data-auth="loading"] in index.css). It keeps its box, can't be
 * focused or clicked, and shows up already reading the right label instead of flashing "Log in" first.
 */
export function AuthLink({ className, decorative = false }: AuthLinkProps) {
  const { status, isAuthenticated } = useAuth();
  const label = isAuthenticated ? DASHBOARD_LABEL : LOGIN_LABEL;
  const classes = className ? `${className} auth-link` : "auth-link";

  if (decorative) {
    return <span className={classes} data-auth={status} aria-hidden="true">{label}</span>;
  }
  return <a className={classes} data-auth={status} href={isAuthenticated ? DASHBOARD_URL : LOGIN_URL}>{label}</a>;
}
