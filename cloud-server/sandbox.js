const active = new Map();

async function getOrCreateContainer(userId, openaiKey, user) {
  if (active.has(userId)) return active.get(userId);
  const container = { id: `stub-${userId}`, podIp: "127.0.0.1" };
  active.set(userId, container);
  return container;
}

async function execInContainer(container, cmd) {
  return `[stub exec] ${cmd}`;
}

function releaseContainer(userId) {
  active.delete(userId);
}

async function destroyContainer(userId) {
  active.delete(userId);
}

function getConcurrencyStats() {
  return { active: active.size, max: 5 };
}

export { getOrCreateContainer, execInContainer, releaseContainer, destroyContainer, getConcurrencyStats };
