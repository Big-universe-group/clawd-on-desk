"use strict";

// Settings information architecture kernel. Categories (sidebar entries) and
// their second-level groups are fixed here; feature modules can only
// contribute sections into them via registerSection(). A group with no
// available section is neither rendered nor listed in the sidebar, which is
// how extension slots such as the `stats` groups stay invisible until a
// module fills them.
//
// Dual-loaded: the Settings renderer reads `globalThis.ClawdSettingsRegistry`
// (classic script, loaded before ui-core.js and the tab scripts), and the main
// process requires it to validate deep-link targets.
(function initSettingsRegistry(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ClawdSettingsRegistry = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function group(id, labelKey) {
    return Object.freeze({ id, labelKey });
  }

  const CATEGORIES = Object.freeze([
    Object.freeze({
      id: "general",
      labelKey: "settingsCategoryGeneral",
      subtitleKey: "settingsSubtitle",
      groups: Object.freeze([
        group("theme", "settingsGroupTheme"),
        group("appearance", "settingsGroupAppearance"),
        group("system", "settingsGroupSystem"),
      ]),
    }),
    Object.freeze({
      id: "notifications",
      labelKey: "settingsCategoryNotifications",
      subtitleKey: "settingsCategoryNotificationsSubtitle",
      groups: Object.freeze([
        group("animation", "settingsGroupAnimation"),
        group("sound", "settingsGroupSound"),
        group("channels", "settingsGroupChannels"),
      ]),
    }),
    Object.freeze({
      id: "shortcuts",
      labelKey: "settingsCategoryShortcuts",
      subtitleKey: "shortcutsSubtitle",
      groups: Object.freeze([
        group("general", "settingsGroupGeneral"),
        group("agents", "settingsGroupAgents"),
        group("stats", "settingsGroupStats"),
      ]),
    }),
    Object.freeze({
      id: "apps",
      labelKey: "settingsCategoryApps",
      subtitleKey: "settingsCategoryAppsSubtitle",
      groups: Object.freeze([
        group("agents", "settingsGroupAgents"),
        group("stats", "settingsGroupStats"),
      ]),
    }),
    // Single-page categories whose one section renders its own page header
    // (Recap keeps its period tabs in the header card; About opens on its hero).
    Object.freeze({
      id: "recap",
      labelKey: "settingsCategoryRecap",
      selfTitled: true,
      groups: Object.freeze([]),
    }),
    Object.freeze({
      id: "about",
      labelKey: "settingsCategoryAbout",
      selfTitled: true,
      groups: Object.freeze([]),
    }),
  ]);

  const DEFAULT_CATEGORY_ID = "general";

  // Pre-IA sidebar tab ids → their home in the category/group table. Used to
  // restore persisted navigation and to accept old deep-link callers.
  const LEGACY_TAB_TARGETS = Object.freeze({
    general: "general",
    theme: "general/theme",
    agents: "apps/agents",
    animOverrides: "notifications/animation",
    "telegram-approval": "notifications/channels",
    "discord-presence": "notifications/channels",
    "remote-ssh": "apps/agents",
    shortcuts: "shortcuts",
    recap: "recap",
    about: "about",
  });

  const categoryById = new Map(CATEGORIES.map((category) => [category.id, category]));
  const sectionsById = new Map();

  function getCategory(categoryId) {
    return categoryById.get(categoryId) || null;
  }

  function getGroup(categoryId, groupId) {
    const category = getCategory(categoryId);
    if (!category) return null;
    return category.groups.find((entry) => entry.id === groupId) || null;
  }

  function getCategories() {
    return CATEGORIES;
  }

  // Strict parse of `<category>` or `<category>/<group>`; legacy tab ids are
  // normalized first. Returns `{ category, group }` (group may be null) or null.
  function resolveTarget(value) {
    if (typeof value !== "string" || !value) return null;
    const raw = Object.prototype.hasOwnProperty.call(LEGACY_TAB_TARGETS, value)
      ? LEGACY_TAB_TARGETS[value]
      : value;
    const parts = raw.split("/");
    if (parts.length > 2) return null;
    const [categoryId, groupId = null] = parts;
    if (!getCategory(categoryId)) return null;
    if (groupId !== null && !getGroup(categoryId, groupId)) return null;
    return { category: categoryId, group: groupId };
  }

  function normalizeTarget(value) {
    const target = resolveTarget(value);
    if (!target) return null;
    return target.group ? `${target.category}/${target.group}` : target.category;
  }

  function registerSection(definition) {
    const section = definition && typeof definition === "object" ? definition : null;
    if (!section || typeof section.id !== "string" || !section.id) {
      throw new Error("settings registry: section id is required");
    }
    if (typeof section.render !== "function") {
      throw new Error(`settings registry: section "${section.id}" needs a render function`);
    }
    const category = getCategory(section.category);
    if (!category) {
      throw new Error(`settings registry: unknown category "${section.category}" for section "${section.id}"`);
    }
    // Sections without a group render in the page lead (under the h1) — the
    // only placement single-page categories have.
    const groupId = section.group == null ? null : section.group;
    if (groupId !== null && !getGroup(category.id, groupId)) {
      throw new Error(`settings registry: unknown group "${category.id}/${groupId}" for section "${section.id}"`);
    }
    if (sectionsById.has(section.id)) {
      throw new Error(`settings registry: section "${section.id}" is already registered`);
    }
    const entry = Object.freeze({
      ...section,
      group: groupId,
      order: Number.isFinite(section.order) ? section.order : 0,
    });
    sectionsById.set(entry.id, entry);
    return entry;
  }

  function getSection(sectionId) {
    return sectionsById.get(sectionId) || null;
  }

  // Registered sections of one category/group (group null/undefined = the
  // page-lead sections), sorted by `order` then registration order.
  function getSections(categoryId, groupId = null) {
    const wanted = groupId == null ? null : groupId;
    const result = [];
    let index = 0;
    for (const section of sectionsById.values()) {
      index += 1;
      if (section.category !== categoryId || section.group !== wanted) continue;
      result.push({ section, index });
    }
    result.sort((a, b) => (a.section.order - b.section.order) || (a.index - b.index));
    return result.map((item) => item.section);
  }

  function isSectionAvailable(section, core) {
    if (!section) return false;
    if (typeof section.isAvailable !== "function") return true;
    return section.isAvailable(core) !== false;
  }

  function getAvailableSections(categoryId, groupId, core) {
    return getSections(categoryId, groupId).filter((section) => isSectionAvailable(section, core));
  }

  // Groups of a category that currently have at least one available section.
  function getVisibleGroups(categoryId, core) {
    const category = getCategory(categoryId);
    if (!category) return [];
    return category.groups.filter((entry) => getAvailableSections(categoryId, entry.id, core).length > 0);
  }

  return Object.freeze({
    CATEGORIES,
    DEFAULT_CATEGORY_ID,
    LEGACY_TAB_TARGETS,
    getCategories,
    getCategory,
    getGroup,
    resolveTarget,
    normalizeTarget,
    registerSection,
    getSection,
    getSections,
    getAvailableSections,
    getVisibleGroups,
  });
});
