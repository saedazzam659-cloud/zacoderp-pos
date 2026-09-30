/** Build an artifact-local route URL for native anchors such as target=_blank links. */
export function appRouteHref(route: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");
  const routePath = route.startsWith("/") ? route : `/${route}`;
  return `${basePath}${routePath}` || "/";
}