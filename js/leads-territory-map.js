import { mountMarketMap } from "./market-map-shell.js";

// The partners' 19 markets by their Census places: Daphne and Fairhope stand for the
// Eastern Shore; 30A / Santa Rosa Beach has no place and lies inside this frame.
const operatingTerritory = [["Mobile", "AL"], ["Daphne", "AL"], ["Fairhope", "AL"], ["Orange Beach", "AL"], ["Gulf Shores", "AL"],
  ["Dothan", "AL"], ["Pensacola", "FL"], ["Pace", "FL"], ["Milton", "FL"], ["Gulf Breeze", "FL"], ["Navarre", "FL"],
  ["Crestview", "FL"], ["Niceville", "FL"], ["Fort Walton Beach", "FL"], ["Destin", "FL"], ["Miramar Beach", "FL"],
  ["Freeport", "FL"], ["Panama City Beach", "FL"], ["Panama City", "FL"], ["Tallahassee", "FL"]].map(([city, state]) => ({ city, state }));
// One persistent MapLibre Search Mode component; counts come from the same
// eligible lead projection as the board. Census points represent places only.
export function marketLocation(lead, places) {
  // The engine serves a lead's city without its state; a city name found once in the territory's states still places it.
  const matches = places.filter(item => item.name.toLowerCase() === String(lead.city || "").toLowerCase() && (!lead.state || item.state === lead.state));
  const place = matches.length === 1 ? matches[0] : null;
  const position = place?.position;
  return Array.isArray(position) && position.length === 2 && position.every(Number.isFinite) &&
    Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90 && position.some(value => value !== 0) ? place : null;
}
export function marketFeatures(groups) {
  return { type: "FeatureCollection", features: groups.flatMap(group => group.locations.map(({ place, leadIds }) =>
    ({ type: "Feature", id: place.id, properties: { key: group.key, place: place.name, count: leadIds.length, leadIds },
      geometry: { type: "Point", coordinates: place.position } }))) };
}
export async function mountTerritoryMap(root, selectLead, { signal, markets = operatingTerritory, padding = 32, describeLead = id => id, loadMapLibre, fetchImpl = fetch } = {}) {
  const [geometry, places] = await Promise.all([
    fetchImpl("/data/leads-territory.geojson", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
    fetchImpl("/data/leads-market-locations.json", { signal }).then(r => { if (!r.ok) throw new Error("Map unavailable"); return r.json(); }),
  ]);
  // The map paints from the page's colour tokens so it follows the theme; with no
  // stylesheet it paints nothing rather than inventing a colour.
  const doc = root.ownerDocument, view = doc.defaultView;
  const token = (name) => view?.getComputedStyle(root).getPropertyValue(name).trim() || (name === "--map-border" ? token("--hairline-strong") : "transparent");
  // Only the background is water. Territory states are land; neighbouring states
  // are muted context land, so nothing outside the Gulf and Atlantic reads as sea.
  const paint = [["ground", "background-color", "--map-water"], ["context", "fill-color", "--map-context"], ["land", "fill-color", "--map-land"], ["borders", "line-color", "--map-border"]];
  const shell = mountMarketMap(root, { interactive: false, signal, loadMapLibre,
    center: [-86.5, 31.9], zoom: 5.5, style: { version: 8, sources: { territory: { type: "geojson", data: geometry } },
      layers: [{ id: "ground", type: "background", paint: { "background-color": token("--map-water") } },
        { id: "context", type: "fill", source: "territory", filter: ["==", ["get", "role"], "context"], paint: { "fill-color": token("--map-context") } },
        { id: "land", type: "fill", source: "territory", filter: ["==", ["get", "role"], "territory"], paint: { "fill-color": token("--map-land") } },
        { id: "borders", type: "line", source: "territory", paint: { "line-color": token("--map-border"), "line-opacity": .9, "line-width": 1 } }] } });
  const mounted = await shell.ready;
  if (!mounted) return null;
  const { map, gl } = mounted;
  const markers = new Map();
  let latest = [], selected = "";
  let picker = null, preview = null;
  const locations = markets.map(market => marketLocation(market, places));
  if (locations.some(place => !place)) { shell.destroy(); throw new Error("Market location unavailable"); }
  const bounds = locations.length ? locations.reduce((bounds, place) => bounds.extend(place.position), new gl.LngLatBounds()) : null;
  const frameTerritory = () => map.fitBounds(bounds, { padding, duration: 0 });
  if (bounds) { frameTerritory(); map.on("resize", frameTerritory); }
  // The paint reads theme tokens once; a theme switch repaints in place.
  const themes = view && new view.MutationObserver(() => { for (const [layer, property, name] of paint) map.setPaintProperty(layer, property, token(name)); });
  themes?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-assist"] });
  function closePreview() {
    if (!preview) return;
    preview.item.button.removeAttribute("aria-describedby");
    preview.element.remove(); preview = null;
  }
  function leavePreview() {
    if (preview && doc.activeElement !== preview.item.button) closePreview();
  }
  function dismissPreview(event) {
    if (event.key === "Escape" && preview) { event.preventDefault(); event.stopPropagation(); closePreview(); }
  }
  root.addEventListener("mouseleave", leavePreview);
  doc.addEventListener("keydown", dismissPreview);
  function updatePreview() {
    if (!preview) return;
    const { item, element } = preview;
    const members = [...new Set(item.features.flatMap(feature => feature.properties.leadIds))];
    const names = places.filter(place => item.features.some(feature => feature.id === place.id)).map(place => `${place.name}, ${place.state}`);
    const count = doc.createElement("strong"), precision = doc.createElement("small"), leads = doc.createElement("div");
    count.textContent = `${members.length} ${members.length === 1 ? "lead" : "leads"} · ${names.join(" · ")}`;
    precision.textContent = "Market area only";
    leads.textContent = members.slice(0, 3).map(describeLead).join(" · ");
    if (members.length > 3) leads.textContent += ` · +${members.length - 3} more`;
    element.replaceChildren(count, precision, leads);
    const frame = root.getBoundingClientRect(), marker = item.button.getBoundingClientRect();
    const before = marker.left - frame.left, after = frame.right - marker.right;
    const onRight = after >= before;
    element.style.maxWidth = `${Math.max(before, after)}px`;
    element.style.left = onRight ? `${marker.right - frame.left}px` : "0px";
  }
  function openPreview(item) {
    if (picker) return;
    if (preview?.item === item) return;
    closePreview();
    const element = doc.createElement("div");
    element.id = `${root.id || "market-map"}-lead-preview`;
    element.className = "map-lead-preview"; element.setAttribute("role", "tooltip");
    element.addEventListener("mouseleave", () => { if (doc.activeElement !== item.button) closePreview(); });
    root.append(element); preview = { item, element };
    item.button.setAttribute("aria-describedby", element.id);
    updatePreview();
  }
  function closePicker(restore = true) {
    if (!picker) return;
    const trigger = picker.trigger;
    picker.element.remove(); picker = null;
    if (restore) (trigger.isConnected ? trigger : root.querySelector(".market-marker"))?.focus({ preventScroll: true });
  }
  function updatePicker() {
    if (!picker) return;
    const members = [...new Set(marketFeatures(latest).features.filter(feature => picker.places.has(feature.id)).flatMap(feature => feature.properties.leadIds))];
    if (!members.length) { closePicker(picker.element.contains(doc.activeElement)); return; }
    for (const [id, button] of picker.buttons) if (!members.includes(id)) { button.remove(); picker.buttons.delete(id); }
    members.forEach((id, index) => {
      let button = picker.buttons.get(id);
      if (!button) {
        button = doc.createElement("button"); button.type = "button"; button.dataset.mapLead = id;
        button.addEventListener("click", () => selectLead(id));
        picker.buttons.set(id, button);
      }
      button.textContent = describeLead(id);
      button.setAttribute("aria-pressed", String(id === selected));
      if (picker.list.children[index] !== button) picker.list.insertBefore(button, picker.list.children[index] || null);
    });
  }
  function openPicker(item) {
    closePicker(false);
    const element = doc.createElement("section"), heading = doc.createElement("div"), title = doc.createElement("strong"), precision = doc.createElement("small"), close = doc.createElement("button"), list = doc.createElement("div");
    element.className = "map-place-members"; element.setAttribute("role", "region"); element.setAttribute("aria-label", "Leads in this place");
    heading.className = "map-place-heading"; title.textContent = "Leads in this place";
    const names = places.filter(place => item.features.some(feature => feature.id === place.id)).map(place => `${place.name}, ${place.state}`);
    precision.textContent = `Market area only · ${names.join(" · ")}`;
    close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "Close place leads");
    close.addEventListener("click", () => closePicker());
    element.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePicker(); } });
    heading.append(title, close); element.append(heading, precision, list); root.after(element);
    picker = { element, list, buttons: new Map(), places: new Set(item.features.map(feature => feature.id)), trigger: item.button };
    updatePicker();
    picker?.list.querySelector("button")?.focus({ preventScroll: true });
  }
  // A marker shows its lead count. Markers that would touch merge, and a click zooms
  // in to them; a marker of one place also shows the place's name where it has room.
  function label(button, { features, named }) {
    const count = doc.createElement("b");
    count.textContent = features.reduce((total, feature) => total + feature.properties.count, 0);
    if (!named) return button.replaceChildren(count);
    const name = doc.createElement("span");
    name.textContent = features[0].properties.place;
    button.replaceChildren(name, count);
  }
  const probe = doc.createElement("button");
  probe.className = "market-marker"; probe.tabIndex = -1; probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position: absolute; visibility: hidden";
  // A label's size depends only on its text, so each text is measured once per draw.
  let sizes = new Map();
  function box(cluster) {
    label(probe, cluster);
    const text = probe.textContent;
    if (!sizes.has(text)) { const { width, height } = probe.getBoundingClientRect(); sizes.set(text, { width, height }); }
    return { ...cluster.position, ...sizes.get(text) };
  }
  const touch = (a, b) => Math.abs(a.x - b.x) * 2 < a.width + b.width + 8 && Math.abs(a.y - b.y) * 2 < a.height + b.height + 8;
  function mergeTouching(clusters) {
    const boxes = clusters.map(box);
    const pair = boxes.flatMap((a, i) => boxes.slice(i + 1).map((b, k) => [i, i + 1 + k, a, b])).find(([, , a, b]) => touch(a, b));
    if (!pair) return clusters;
    const [kept, merged] = pair;
    return mergeTouching(clusters.map((item, index) => index === kept ? { ...item, features: [...item.features, ...clusters[merged].features] } : item).filter((_, index) => index !== merged));
  }
  // Largest markets claim room for their names first.
  function nameWhereRoom(clusters) {
    const boxes = clusters.map(box), { width, height } = root.getBoundingClientRect();
    const inside = ({ x, y, width: w, height: h }) => x - w / 2 >= 0 && x + w / 2 <= width && y - h / 2 >= 0 && y + h / 2 <= height;
    return clusters.map((cluster, index) => {
      if (new Set(cluster.features.map(feature => feature.id)).size > 1) return cluster;
      const named = box({ ...cluster, named: true });
      if (!inside(named) || boxes.some((other, at) => at !== index && touch(named, other))) return cluster;
      boxes[index] = named;
      return { ...cluster, named: true };
    });
  }
  function draw() {
    root.append(probe); sizes = new Map();
    const total = cluster => cluster.features.reduce((sum, feature) => sum + feature.properties.count, 0);
    const clusters = nameWhereRoom(mergeTouching(marketFeatures(latest).features.sort((a, b) => b.properties.count - a.properties.count)
      .map(feature => ({ position: map.project(feature.geometry.coordinates), features: [feature], named: false }))).sort((a, b) => total(b) - total(a)));
    probe.remove();
    const keys = new Set(clusters.map(c => c.features.map(f=>f.id).sort().join("/")));
    for (const [key,item] of markers) if (!keys.has(key)) { if (preview?.item === item) closePreview(); item.marker.remove(); markers.delete(key); }
    for (const cluster of clusters) {
      const key=cluster.features.map(f=>f.id).sort().join("/");
      let item=markers.get(key);
      if (!item) {
        const button=root.ownerDocument.createElement("button");button.type="button";button.className="market-marker";button.dataset.mapMarker=key;
        item={button,features:cluster.features,marker:new gl.Marker({element:button}).setLngLat(cluster.features[0].geometry.coordinates).addTo(map)};
        button.addEventListener("mouseenter", () => openPreview(item));
        // eslint-disable-next-line no-restricted-syntax -- Marker focus only displays the loaded cluster preview; it performs no HTTP reads.
        button.addEventListener("focus", () => openPreview(item));
        button.addEventListener("blur", () => { if (preview?.item === item && !preview.element.matches(":hover")) closePreview(); });
        button.addEventListener("click",()=>{
          button.focus({ preventScroll: true });
          closePreview();
          if(new Set(item.features.map(feature => feature.id)).size===1 || map.getZoom() >= 11) {
            const leadIds = [...new Set(item.features.flatMap(feature => feature.properties.leadIds))];
            if (leadIds.length === 1) selectLead(leadIds[0]);
            else openPicker(item);
            return;
          }
          const bounds=new gl.LngLatBounds();item.features.forEach(f=>bounds.extend(f.geometry.coordinates));
          map.fitBounds(bounds,{padding:65,maxZoom:11,duration:root.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches?0:200});
        });
        markers.set(key,item);
      }
      item.features=cluster.features;
      const title=cluster.features.map(f=>`${f.properties.key}: ${f.properties.count}`).join(" · ");
      label(item.button, cluster);
      item.button.setAttribute("aria-label",new Set(cluster.features.map(feature => feature.id)).size>1 && map.getZoom()<11?`Zoom to markets · ${title}`:`${title} leads`);
      const leadIds = cluster.features.flatMap(f => f.properties.leadIds);
      item.button.dataset.leadIds = JSON.stringify(leadIds);
      item.button.setAttribute("aria-pressed",String(leadIds.includes(selected)));
    }
    updatePicker(); updatePreview();
  }
  map.on("movestart",closePreview);
  map.on("moveend",draw);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { map.off("idle", ready); map.off("error", failed); signal?.removeEventListener("abort", aborted); };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Map unavailable")); };
      const aborted = () => { cleanup(); reject(new DOMException("Map cancelled", "AbortError")); };
      map.on("idle", ready); map.on("error", failed); signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  } catch (error) { root.removeEventListener("mouseleave", leavePreview); doc.removeEventListener("keydown", dismissPreview); closePreview(); map.off("movestart", closePreview); map.off("moveend", draw); map.off("resize", frameTerritory); themes?.disconnect(); shell.destroy(); throw error; }
  return { resize() { map.resize(); }, locate(lead) { return marketLocation(lead, places); },
    update(groups, leadId) { latest=groups;selected=leadId;draw(); },
    dispose() {root.removeEventListener("mouseleave",leavePreview);doc.removeEventListener("keydown",dismissPreview);closePreview();closePicker(false);map.off("movestart",closePreview);map.off("moveend",draw);map.off("resize",frameTerritory);themes?.disconnect();for(const item of markers.values())item.marker.remove();shell.destroy();} };
}
