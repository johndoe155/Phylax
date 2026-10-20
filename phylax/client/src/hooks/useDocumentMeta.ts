import { useEffect } from "react";

/**
 * Sets the tab title and the description meta for as long as the calling page is mounted, then puts the previous
 * values back. With `noindex`, also asks search engines to skip the page, which is what a pre-launch draft wants.
 */
export function useDocumentMeta(title: string, description: string, noindex: boolean) {
  useEffect(() => {
    const previousTitle = document.title;
    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = meta?.getAttribute("content") ?? null;
    document.title = title;
    meta?.setAttribute("content", description);
    return () => {
      document.title = previousTitle;
      if (meta && previousDescription !== null) meta.setAttribute("content", previousDescription);
    };
  }, [title, description]);

  useEffect(() => {
    if (!noindex) return;
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.append(robots);
    return () => robots.remove();
  }, [noindex]);
}
