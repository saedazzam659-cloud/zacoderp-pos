import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { MODULE_GROUPS } from "../src/lib/menuItems";
import { getUserGuideChapters } from "../src/lib/userGuideContent";

const disabledModulePermissions = Object.fromEntries(
  [...new Set(MODULE_GROUPS.flatMap((group) => group.moduleKeys))]
    .map((key) => [key, false]),
);

test("guide keeps its general chapter and hides disabled company modules", () => {
  const chapters = getUserGuideChapters({
    role: "admin",
    company: { menuPermissions: disabledModulePermissions },
  });

  assert.deepEqual(chapters.map((chapter) => chapter.id), ["getting-started"]);
});

test("guide includes enabled chapters but omits company-hidden screens", () => {
  const salesGroup = MODULE_GROUPS.find((group) => group.key === "sales");
  assert.ok(salesGroup);
  const hiddenPath = salesGroup.screens[0]?.path;
  assert.ok(hiddenPath);

  const chapters = getUserGuideChapters({
    role: "admin",
    company: {
      menuPermissions: {
        ...disabledModulePermissions,
        sales_module: true,
        demo_analytics: true,
        [`nav:${hiddenPath}`]: false,
      },
    },
  });

  const ids = chapters.map((chapter) => chapter.id);
  assert.ok(ids.includes("sales"));
  assert.ok(!ids.includes("demoAnalytics"));
  const sales = chapters.find((chapter) => chapter.id === "sales");
  assert.ok(sales);
  assert.ok(!sales.screens.some((screen) => screen.path === hiddenPath));
  assert.ok(sales.screens.length > 0);
});

test("simple manufacturing guide uses the authentic screenshot asset", () => {
  const disabledChapters = getUserGuideChapters({
    role: "admin",
    company: {
      menuPermissions: {
        ...disabledModulePermissions,
        simple_manufacturing: false,
      },
    },
  });
  assert.ok(!disabledChapters.some((item) => item.id === "simple_manufacturing"));

  const visibleChapters = getUserGuideChapters({
    role: "admin",
    company: {
      menuPermissions: {
        ...disabledModulePermissions,
        simple_manufacturing: true,
      },
    },
  });
  const visibleChapter = visibleChapters.find((item) => item.id === "simple_manufacturing");

  assert.equal(visibleChapter?.screenshot?.src, "/user-guide/screenshots/simple-manufacturing.png");
  assert.ok(existsSync(new URL(
    "../public/user-guide/screenshots/simple-manufacturing.png",
    import.meta.url,
  )));
  assert.deepEqual(visibleChapter?.screens.map((screen) => screen.path), ["/simple-manufacturing"]);

  const hiddenChapters = getUserGuideChapters({
    role: "admin",
    company: {
      menuPermissions: {
        ...disabledModulePermissions,
        simple_manufacturing: true,
        "nav:/simple-manufacturing": false,
      },
    },
  });
  const hiddenChapter = hiddenChapters.find((item) => item.id === "simple_manufacturing");
  assert.ok(hiddenChapter);
  assert.deepEqual(hiddenChapter.screens, []);
});