/**
 * docs/feature-map.json must match the real routers (run by `bun run lint`).
 *
 * Page routes are derived from the Next.js App Router directories named in the
 * map's `apps` (every `page.tsx`/`page.ts`; `[locale]` and `(group)` segments
 * do not appear in the URL). API route handlers (`route.ts`) are out of scope.
 * The check fails when:
 *   - a router page route is in neither `features` nor `ignoredRoutes`;
 *   - a feature has no route;
 *   - a mapped route (feature or ignored) does not exist in its router;
 *   - a feature's `journey` file does not exist, or ids repeat.
 *
 *   bun scripts/check-feature-map.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAP_PATH = join(ROOT, "docs", "feature-map.json");

type Feature = {
  id?: string;
  name?: string;
  app?: string;
  route?: string;
  routes?: string[];
  journey?: string;
};

type FeatureMap = {
  apps?: Record<string, string>;
  features?: Feature[];
  ignoredRoutes?: { app?: string; route?: string; reason?: string }[];
};

/** URL path for an App Router page file relative to its app directory. */
export function pageRoute(pageFile: string): string {
  const segments = pageFile
    .split(sep)
    .slice(0, -1)
    .filter(
      (segment) =>
        segment !== "[locale]" &&
        !(segment.startsWith("(") && segment.endsWith(")")) &&
        !segment.startsWith("@"),
    );
  return `/${segments.join("/")}`;
}

export function routerRoutes(appDir: string): Set<string> {
  const routes = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith("_")) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) {
        routes.add(pageRoute(relative(appDir, path)));
      }
    }
  };
  walk(appDir);
  return routes;
}

export function checkFeatureMap(map: FeatureMap, root = ROOT): string[] {
  const errors: string[] = [];
  const apps = map.apps ?? {};
  if (Object.keys(apps).length === 0) {
    errors.push('"apps" must name at least one router directory');
  }
  const routers = new Map<string, Set<string>>();
  for (const [app, dir] of Object.entries(apps)) {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) {
      errors.push(`app "${app}": router directory ${dir} does not exist`);
      continue;
    }
    routers.set(app, routerRoutes(absolute));
  }
  const defaultApp = Object.keys(apps)[0] ?? "";
  const covered = new Map<string, Set<string>>();
  const cover = (app: string, route: string, owner: string) => {
    const router = routers.get(app);
    if (!router) {
      errors.push(`${owner}: unknown app "${app}"`);
      return;
    }
    if (!router.has(route)) {
      errors.push(
        `${owner}: route ${route} does not exist in the ${app} router`,
      );
    }
    if (!covered.has(app)) covered.set(app, new Set());
    covered.get(app)!.add(route);
  };

  const ids = new Set<string>();
  for (const [index, feature] of (map.features ?? []).entries()) {
    const label = `feature ${feature.id ?? `#${index}`}`;
    if (!feature.id) errors.push(`feature #${index} has no id`);
    else if (ids.has(feature.id)) errors.push(`${label}: duplicate id`);
    else ids.add(feature.id);
    if (!feature.name) errors.push(`${label}: no name`);
    const routes = [
      ...(feature.route ? [feature.route] : []),
      ...(feature.routes ?? []),
    ].filter((route) => route.trim() !== "");
    if (routes.length === 0) errors.push(`${label}: no route`);
    for (const route of routes) {
      cover(feature.app ?? defaultApp, route, label);
    }
    if (feature.journey && !existsSync(join(root, feature.journey))) {
      errors.push(`${label}: journey ${feature.journey} does not exist`);
    }
  }
  for (const ignored of map.ignoredRoutes ?? []) {
    const label = `ignored route ${ignored.route ?? "(none)"}`;
    if (!ignored.route) errors.push(`${label}: no route`);
    if (!ignored.reason) errors.push(`${label}: no reason`);
    if (ignored.route) cover(ignored.app ?? defaultApp, ignored.route, label);
  }

  for (const [app, routes] of routers) {
    for (const route of [...routes].sort()) {
      if (!covered.get(app)?.has(route)) {
        errors.push(
          `${app} page route ${route} is not in docs/feature-map.json (add a feature, or an ignoredRoutes entry with a reason)`,
        );
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as FeatureMap;
  const errors = checkFeatureMap(map);
  if (errors.length > 0) {
    console.error("docs/feature-map.json is out of date:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const total = [...Object.keys(map.apps ?? {})].length;
  console.log(
    `feature map ok: ${map.features?.length ?? 0} features, ${map.ignoredRoutes?.length ?? 0} ignored routes across ${total} app routers`,
  );
}
