let counter = 0;

export function rule(host, matchType, routeMode, overrides = {}) {
  counter++;
  return Object.assign({
    id: "r" + counter,
    name: host + " " + matchType + " " + routeMode,
    host,
    matchType,
    routeMode,
    enabled: true,
    source: "User",
    notes: null
  }, overrides);
}

export function exact(host, routeMode, overrides) {
  return rule(host, "ExactHost", routeMode, overrides);
}

export function domain(host, routeMode, overrides) {
  return rule(host, "DomainAndSubdomains", routeMode, overrides);
}

export function state(rules, overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    revision: 1,
    defaultRoute: "Direct",
    rules
  }, overrides);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}

export function shuffle(random, items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function codes(issues) {
  return issues.map((entry) => entry.code);
}
