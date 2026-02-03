// static/js/app.js
function formatTimeTo12Hour(timeStr) {
  if (!timeStr || typeof timeStr !== "string" || !timeStr.includes(":")) return timeStr || "";
  const [hour, minute] = timeStr.split(":");
  const h = parseInt(hour, 10);
  if (Number.isNaN(h)) return timeStr;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = ((h + 11) % 12 + 1);
  return `${hour12}:${minute} ${suffix}`;
}

(async function () {
  try {
    const res = await fetch("/static/data/campus.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`campus.json ${res.status}`);
    const data = await res.json();

    const width = data.canvas?.width || 1200;
    const height = data.canvas?.height || 800;

    const map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 2,
      zoomSnap: 0.25
    });

    const invertY = true;
    const Y = y => invertY ? (height - y) : y;

    const byId = Object.fromEntries((data.buildings || []).map(b => [b.id, b]));

    const extent = { minLat: +Infinity, minLng: +Infinity, maxLat: -Infinity, maxLng: -Infinity };
    const addLL = (lat, lng) => {
      if (lat < extent.minLat) extent.minLat = lat;
      if (lat > extent.maxLat) extent.maxLat = lat;
      if (lng < extent.minLng) extent.minLng = lng;
      if (lng > extent.maxLng) extent.maxLng = lng;
    };

    (data.buildings || []).forEach(b => {
      const hw = (b.w ?? 120) / 2, hh = (b.h ?? 60) / 2;
      const corners = [
        [Y(b.y + hh), b.x - hw],
        [Y(b.y + hh), b.x + hw],
        [Y(b.y - hh), b.x - hw],
        [Y(b.y - hh), b.x + hw],
      ];
      corners.forEach(([lat, lng]) => addLL(lat, lng));
    });

    (data.walkways || []).forEach(w => {
      const A = byId[w.from], B = byId[w.to]; if (!A || !B) return;
      const pts = [[Y(A.y), A.x]]
        .concat((Array.isArray(w.via) ? w.via : []).map(([x, y]) => [Y(y), x]))
        .concat([[Y(B.y), B.x]]);
      pts.forEach(([lat, lng]) => addLL(lat, lng));
    });

    if (!isFinite(extent.minLat)) {
      extent.minLat = 0; extent.minLng = 0;
      extent.maxLat = height; extent.maxLng = width;
    }

    const pad = 40;
    const bounds = L.latLngBounds(
      [[extent.minLat - pad, extent.minLng - pad],
       [extent.maxLat + pad, extent.maxLng + pad]]
    );

    map.fitBounds(bounds);

    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
    L.control.zoom({ position: 'topright' }).addTo(map);

    map.createPane('pane-boxes');    map.getPane('pane-boxes').style.zIndex    = 400;
    map.createPane('pane-walkways'); map.getPane('pane-walkways').style.zIndex = 410;
    map.createPane('pane-route');    map.getPane('pane-route').style.zIndex    = 420;

    const boxes = L.layerGroup().addTo(map);
    const walk  = L.layerGroup().addTo(map);
    const route = L.layerGroup().addTo(map);

    const info = document.getElementById("info");
    const fromEl = document.getElementById("from");
    const toEl = document.getElementById("to");
    const showInfo = html => { if (info) info.innerHTML = html; };

    const LINE_COLOR = "#9ca3af";

    const rectBounds = b => {
      const hw = (b.w ?? 120) / 2;
      const hh = (b.h ?? 60) / 2;
      return [[Y(b.y + hh), b.x - hw], [Y(b.y - hh), b.x + hw]];
    };

    // ===== Building modal refs =====
    const bdlg   = document.getElementById("buildingDlg");
    const bTitle = document.getElementById("bldgTitle");
    const bRooms = document.getElementById("bldgRooms");
    const bCRs   = document.getElementById("bldgCRs");
    document.getElementById("closeBuildingDlg")?.addEventListener("click", () => bdlg.close());

    function renderSchedTable(rows) {
      return rows && rows.length ? `
        <table style="width:100%;border-collapse:collapse;margin-top:8px">
          <thead><tr>
            <th>Day</th><th>Start</th><th>End</th><th>Subject</th><th>Section</th><th>Teacher</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr style="text-align:center">
                <td>${r.day || ""}</td>
                <td>${formatTimeTo12Hour(r.start) || ""}</td>
                <td>${formatTimeTo12Hour(r.end) || ""}</td>
                <td>${r.subject || ""}</td>
                <td>${r.section || ""}</td>
                <td>${r.teacher || ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<p style="margin:8px 0 0">No schedule available.</p>`;
    }

    async function openBuildingModal(b) {
      if (!bdlg) return;
      if (bTitle) bTitle.textContent = b.name;

      // show modal immediately so user sees "Loading..."
      if (bRooms) bRooms.innerHTML = `<p>Loading rooms...</p>`;
      if (bCRs) bCRs.innerHTML = ``;
      if (typeof bdlg.showModal === "function") bdlg.showModal();

      try {
        // ✅ IMPORTANT: use SAME domain (no hardcoding)
        const roomsRes = await fetch("/api/v1/rooms/");
        if (!roomsRes.ok) throw new Error(`Rooms API ${roomsRes.status}`);
        const allRooms = await roomsRes.json();

        const all = allRooms.filter(r => (r.parent || "").trim() === b.id);
        const rooms = all.filter(r => r.type === "room");
        const crs   = all.filter(r => r.type === "cr");

        // Rooms list
        if (rooms.length) {
          bRooms.innerHTML = rooms.map(r => `
            <div class="row" data-room-id="${r.tag}"
              style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fafafa;cursor:pointer;margin:6px 0">
              <div><strong>${r.name}</strong></div>
              <div class="badge"
                style="font-size:12px;padding:2px 8px;border-radius:999px;background:#e5e7eb">
                Click to view schedule
              </div>
            </div>
            <div id="sched-${r.tag}" style="display:none;margin:6px 0 10px;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fff">
              <p style="margin:0">Click to load schedule</p>
            </div>
          `).join("");
        } else {
          bRooms.innerHTML = `<p>No rooms defined for this building yet.</p>`;
        }

        // CRs
        if (crs.length) {
          bCRs.innerHTML = crs.map(c => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fafafa;margin:6px 0">
              <div><strong>${c.name}</strong></div>
              <div style="font-size:12px;padding:2px 8px;border-radius:999px;background:#e5e7eb">Facility</div>
            </div>
          `).join("");
        } else {
          bCRs.innerHTML = `<p>No CR listed for this building.</p>`;
        }

        // bind toggles
        bdlg.querySelectorAll('[data-room-id]').forEach(row => {
          row.addEventListener('click', async () => {
            const tag = row.getAttribute('data-room-id');
            const panel = document.getElementById('sched-' + tag);
            if (!panel) return;

            const isHidden = panel.style.display === 'none' || !panel.style.display;

            if (isHidden) {
              panel.style.display = 'block';
              panel.innerHTML = `<p style="margin:0">Loading schedule...</p>`;
              try {
                const schedRes = await fetch(`/api/v1/schedules/${tag}`);
                if (!schedRes.ok) throw new Error(`Schedules API ${schedRes.status}`);
                const schedules = await schedRes.json();
                panel.innerHTML = renderSchedTable(schedules);
              } catch (err) {
                console.error(`❌ Failed to fetch schedules for ${tag}:`, err);
                panel.innerHTML = `<p style="margin:0">Error loading schedules.</p>`;
              }
            } else {
              panel.style.display = 'none';
            }
          });
        });

      } catch (err) {
        console.error("❌ Failed to load rooms from API:", err);
        showInfo(`<b>Error:</b> Could not load rooms. Check API is running.`);
        if (bRooms) bRooms.innerHTML = `<p>Error loading rooms.</p>`;
        if (bCRs) bCRs.innerHTML = ``;
      }
    }

    // -------- Buildings overlays --------
    (data.buildings || []).forEach(b => {
      if (b.img) {
        const img = L.imageOverlay(b.img, rectBounds(b), {
          pane: 'pane-boxes',
          interactive: true,
          opacity: 1
        }).addTo(boxes);

        // safe cursor set
        const el = img.getElement && img.getElement();
        if (el) el.style.cursor = "pointer";

        img.bindTooltip(b.name, { direction: "center", permanent: true, className: "bldg-label" });
        img.on("click", () => openBuildingModal(b));
      } else {
        const r = L.rectangle(rectBounds(b), {
          pane: 'pane-boxes',
          weight: 2,
          opacity: 1,
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.15
        }).addTo(boxes);

        r.bindTooltip(b.name, { direction: "center", permanent: true, className: "bldg-label" });
        r.on("click", () => openBuildingModal(b));
      }

      fromEl.add(new Option(b.name, b.id));
      toEl.add(new Option(b.name, b.id));
    });

    // ===== Walkway routing graph logic (unchanged) =====
    const nodes   = {};
    const graph   = {};
    const anchors = {};
    let viaCounter = 0;

    const SNAP_EPS = 2;
    const findExistingKey = (x, y) => {
      for (const [k, p] of Object.entries(nodes)) {
        if (Math.abs(p.x - x) <= SNAP_EPS && Math.abs(p.y - y) <= SNAP_EPS) return k;
      }
      return null;
    };
    const addViaNode = (x, y) => {
      const existing = findExistingKey(x, y);
      if (existing) return existing;
      const key = `v:${(viaCounter++).toString(36)}`;
      nodes[key] = { x, y };
      return key;
    };
    const addEdge = (a, b) => {
      (graph[a] ||= []).push(b);
      (graph[b] ||= []).push(a);
    };
    const addAnchor = (bid, nodeKey) => {
      (anchors[bid] ||= new Set()).add(nodeKey);
    };

    (data.walkways || []).forEach(w => {
      if (!w || typeof w !== "object" || !w.from || !w.to) return;
      const A = byId[w.from], B = byId[w.to]; if (!A || !B) return;

      const vias = Array.isArray(w.via) ? w.via.slice() : [];

      const drawXY = vias.length ? vias : [[A.x, A.y], [B.x, B.y]];
      const drawLatLng = drawXY.map(([x, y]) => [Y(y), x]);
      L.polyline(drawLatLng, { pane: 'pane-walkways', weight: 6, opacity: 0.95, color: LINE_COLOR })
        .addTo(walk)
        .on("click", () => showInfo(`<b>Walkway:</b> ${A.name} ↔ ${B.name}`));

      if (vias.length) {
        const seqKeys = vias.map(([x, y]) => addViaNode(x, y));
        for (let i = 1; i < seqKeys.length; i++) addEdge(seqKeys[i - 1], seqKeys[i]);
        addAnchor(w.from, seqKeys[0]);
        addAnchor(w.to,   seqKeys[seqKeys.length - 1]);
      } else {
        const k1 = addViaNode(A.x, A.y);
        const k2 = addViaNode(B.x, B.y);
        addEdge(k1, k2);
        addAnchor(w.from, k1);
        addAnchor(w.to,   k2);
      }
    });

    function bfsFromSources(sources, goalsSet) {
      const q = [];
      const prev = {};
      sources.forEach(s => { q.push(s); prev[s] = null; });

      while (q.length) {
        const u = q.shift();
        if (goalsSet.has(u)) {
          const path = [];
          for (let cur = u; cur != null; cur = prev[cur]) path.unshift(cur);
          return path;
        }
        (graph[u] || []).forEach(v => {
          if (!(v in prev)) { prev[v] = u; q.push(v); }
        });
      }
      return null;
    }

    document.getElementById("routeBtn").onclick = () => {
      route.clearLayers();
      const sId = fromEl.value, tId = toEl.value;
      if (!sId || !tId || sId === tId) return;

      const srcAnchors = Array.from(anchors[sId] || []);
      const dstAnchors = new Set(Array.from(anchors[tId] || []));

      if (!srcAnchors.length || !dstAnchors.size) {
        showInfo("No path: missing walkway anchors near one or both buildings. Add VIA points near building edges in campus.json.");
        return;
      }

      const keyPath = bfsFromSources(srcAnchors, dstAnchors);
      if (!keyPath) { showInfo("No path found."); return; }

      const latlngs = keyPath.map(k => {
        const { x, y } = nodes[k];
        return [Y(y), x];
      });

      L.polyline(latlngs, { pane: 'pane-route', weight: 6, opacity: 0.95, color: "red" }).addTo(route);
      showInfo(`<b>Route:</b> ${byId[sId].name} → ${byId[tId].name}`);
    };

    document.getElementById("homeBtn").onclick = () => {
      route.clearLayers();
      map.fitBounds(bounds);
      showInfo("Click a building to view rooms and schedules.");
    };

  } catch (e) {
    console.error(e);
    alert("Failed to load campus map data.\n" + e.message + "\nCheck console for details.");
  }
})();
