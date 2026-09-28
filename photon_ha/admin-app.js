const dom = {
  status: document.querySelector("#admin-status"), search: document.querySelector("#picker-search"),
  domain: document.querySelector("#domain-filter"), selectedOnly: document.querySelector("#selected-only"),
  save: document.querySelector("#save-picker"), list: document.querySelector("#picker-list"),
  discovered: document.querySelector("#discovered-count"), selected: document.querySelector("#selected-count"), room: document.querySelector("#bridge-room"),
};
let entities = [];
let selected = new Map();

async function load() {
  const [status, discovered, exposed] = await Promise.all([api("api/status"), api("api/entities"), api("api/exposed")]);
  entities = discovered.filter((entity) => !entity.disabled).sort((a, b) => `${a.areaName} ${a.name}`.localeCompare(`${b.areaName} ${b.name}`));
  selected = new Map(exposed.entities.map((item) => [item.entityId, item]));
  const domains = [...new Set(entities.map((entity) => entity.domain))].sort();
  dom.domain.innerHTML += domains.map((domain) => `<option>${escapeHtml(domain)}</option>`).join("");
  dom.status.textContent = status.haConnected ? "HA online" : "HA offline";
  dom.status.className = `status ${status.haConnected ? "online" : "warning"}`;
  dom.discovered.textContent = `${status.discovered} discovered`;
  dom.room.textContent = `Photon room: ${status.photonRoom}`;
  render();
}

function render() {
  const query = dom.search.value.trim().toLowerCase();
  const filtered = entities.filter((entity) => {
    if (dom.domain.value && entity.domain !== dom.domain.value) return false;
    if (dom.selectedOnly.checked && !selected.has(entity.entityId)) return false;
    return `${entity.name} ${entity.entityId} ${entity.deviceName} ${entity.areaName}`.toLowerCase().includes(query);
  });
  dom.selected.textContent = `${selected.size} exposed`;
  dom.list.innerHTML = filtered.map((entity) => {
    const selection = selected.get(entity.entityId);
    const canControl = entity.control.type !== "read_only";
    return `<article class="picker-row" data-id="${escapeHtml(entity.entityId)}">
      <label class="pick-main"><input class="expose" type="checkbox" ${selection ? "checked" : ""}>
        <span><strong>${escapeHtml(entity.name)}</strong><small>${escapeHtml(entity.entityId)} · ${escapeHtml(entity.areaName || entity.deviceName || "Unassigned")}</small></span>
      </label>
      <input class="remote-name" value="${escapeHtml(selection?.name || entity.name)}" aria-label="Remote name" ${selection ? "" : "disabled"}>
      <label class="check"><input class="writable" type="checkbox" ${selection?.writable !== false && canControl ? "checked" : ""} ${selection && canControl ? "" : "disabled"}> Control</label>
      <span class="control-kind">${escapeHtml(entity.control.type.replaceAll("_", " "))}</span>
    </article>`;
  }).join("") || '<div class="panel empty">No matching entities.</div>';
  dom.list.querySelectorAll(".picker-row").forEach((row) => {
    const checkbox = row.querySelector(".expose");
    checkbox.addEventListener("change", () => {
      const entity = entities.find((item) => item.entityId === row.dataset.id);
      if (checkbox.checked) selected.set(entity.entityId, { entityId: entity.entityId, name: entity.name, writable: entity.control.type !== "read_only" });
      else selected.delete(entity.entityId);
      render();
    });
    row.querySelector(".remote-name")?.addEventListener("change", (event) => { if (selected.has(row.dataset.id)) selected.get(row.dataset.id).name = event.target.value; });
    row.querySelector(".writable")?.addEventListener("change", (event) => { if (selected.has(row.dataset.id)) selected.get(row.dataset.id).writable = event.target.checked; });
  });
}

dom.search.addEventListener("input", render);
dom.domain.addEventListener("change", render);
dom.selectedOnly.addEventListener("change", render);
dom.save.addEventListener("click", async () => {
  dom.save.disabled = true; dom.save.textContent = "Saving…";
  try { await api("api/exposed", { method: "PUT", body: JSON.stringify({ version: 1, entities: [...selected.values()] }) }); dom.save.textContent = "Saved"; }
  catch (error) { alert(error.message); dom.save.textContent = "Save selection"; }
  finally { setTimeout(() => { dom.save.disabled = false; dom.save.textContent = "Save selection"; }, 1000); }
});

async function api(url, options) { const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options }); const value = await response.json(); if (!response.ok) throw new Error(value.error || "Request failed"); return value; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }
load().catch((error) => { dom.status.textContent = "Bridge unavailable"; dom.status.className = "status offline"; dom.list.innerHTML = `<div class="panel error">${escapeHtml(error.message)}</div>`; });
