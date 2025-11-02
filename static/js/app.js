// static/js/app.js
(async function () {
  try {
    const res = await fetch("/static/data/campus.json");
    if (!res.ok) throw new Error(`campus.json ${res.status}`);
    const data = await res.json();

    const width  = data.canvas?.width  || 1200;
    const height = data.canvas?.height || 800;

    // Create map
    const map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 2,
      zoomSnap: 0.25
    });

    // Flip Y so coordinates match normal Cartesian in your JSON
    const invertY = true;
    const Y = y => invertY ? (height - y) : y;

    // Index buildings by id (needed for bounds + drawing)
    const byId = Object.fromEntries((data.buildings || []).map(b => [b.id, b]));

    // --- Compute dynamic bounds from buildings + walkways (supports negative X, large Y) ---
    const extent = { minLat: +Infinity, minLng: +Infinity, maxLat: -Infinity, maxLng: -Infinity };
    const addLL = (lat, lng) => {
      if (lat < extent.minLat) extent.minLat = lat;
      if (lat > extent.maxLat) extent.maxLat = lat;
      if (lng < extent.minLng) extent.minLng = lng;
      if (lng > extent.maxLng) extent.maxLng = lng;
    };

    // include building rectangles (four corners)
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

    // include walkway points (endpoints + VIA)
    (data.walkways || []).forEach(w => {
      const A = byId[w.from], B = byId[w.to]; if (!A || !B) return;
      const pts = [[Y(A.y), A.x]]
        .concat((Array.isArray(w.via) ? w.via : []).map(([x, y]) => [Y(y), x]))
        .concat([[Y(B.y), B.x]]);
      pts.forEach(([lat, lng]) => addLL(lat, lng));
    });

    // fallback if nothing found
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

    // ✅ Re-enable zoom interactions
    map.scrollWheelZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
    L.control.zoom({ position: 'topright' }).addTo(map);

    // --- Z-index panes so the red route is always on top ---
    map.createPane('pane-boxes');    map.getPane('pane-boxes').style.zIndex    = 400;
    map.createPane('pane-walkways'); map.getPane('pane-walkways').style.zIndex = 410;
    map.createPane('pane-route');    map.getPane('pane-route').style.zIndex    = 420;

    // Layers
    const boxes = L.layerGroup().addTo(map);
    const walk  = L.layerGroup().addTo(map);
    const route = L.layerGroup().addTo(map);

    // UI
    const info   = document.getElementById("info");
    const fromEl = document.getElementById("from");
    const toEl   = document.getElementById("to");
    const showInfo = html => info.innerHTML = html;
    const scheduleFor = id => (data.schedules && data.schedules[id]) || [];

    const LINE_COLOR = "#9ca3af"; // gray for walkways

    const rectBounds = b => {
      const hw = (b.w ?? 120) / 2;
      const hh = (b.h ?? 60) / 2;
      return [[Y(b.y + hh), b.x - hw], [Y(b.y - hh), b.x + hw]];
    };

    // -------- Buildings (image overlays if available, otherwise rectangles) --------
    (data.buildings || []).forEach(b => {
      if (b.img) {
        // Make overlay interactive so it can receive click events
        const img = L.imageOverlay(b.img, rectBounds(b), {
          pane: 'pane-boxes',
          interactive: true,      // <-- REQUIRED for clicks
          opacity: 1
        }).addTo(boxes);

        // Optional pointer cursor
        img.getElement?.()?.style && (img.getElement().style.cursor = 'pointer');

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

      // Populate route selects
      fromEl.add(new Option(b.name, b.id));
      toEl.add(new Option(b.name, b.id));
    });

    // ==================================================================
    // Walkway-only graph with building ANCHORS (no building-center nodes)
    // ==================================================================
    const nodes   = {};   // key -> { x, y } (campus coords, NOT flipped)
    const graph   = {};   // key -> neighbor keys array
    const anchors = {};   // buildingId -> Set(nodeKey) attached walkway nodes
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

    // Draw walkways in gray and build the graph only from VIA points
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

    // -------- BFS from multiple source anchors to multiple target anchors --------
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

    // -------- Route button: draw RED route along gray walkways only --------
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
        const { x, y } = nodes[k];      // campus coords
        return [Y(y), x];               // to Leaflet [lat, lng]
      });

      L.polyline(latlngs, { pane: 'pane-route', weight: 6, opacity: 0.95, color: "red" }).addTo(route);
      showInfo(`<b>Route:</b> ${byId[sId].name} → ${byId[tId].name}`);
    };

    document.getElementById("homeBtn").onclick = () => {
      route.clearLayers();
      map.fitBounds(bounds);
      showInfo("Click a building to view rooms and schedules.");
    };

    // ===== Building modal logic =====
    const bdlg   = document.getElementById("buildingDlg");
    const bTitle = document.getElementById("bldgTitle");
    const bRooms = document.getElementById("bldgRooms");
    const bCRs   = document.getElementById("bldgCRs");
    document.getElementById("closeBuildingDlg")?.addEventListener("click", () => bdlg.close());

    // function openBuildingModal(b) {
    async function openBuildingModal(b) {
      bTitle.textContent = b.name;

      // const all = (data.rooms || []).filter(r => (r.parent || "") === b.id);
      // const rooms = all.filter(r => r.type === "room");
      // const crs   = all.filter(r => r.type === "cr");
      try {
          // ✅ Call your Flask API to get live rooms 
          const res = await fetch("https://python-ss4m.onrender.com/api/v1/rooms/"); 
          const allRooms = await res.json();

          // ✅ Filter by parent building
          const all = allRooms.filter(r => (r.parent || "") === b.id);
          const rooms = all.filter(r => r.type === "room");
          const crs   = all.filter(r => r.type === "cr");

      const renderSchedTable = (rows) => rows && rows.length ? `
        <table style="width:100%;border-collapse:collapse;margin-top:8px">
          <thead><tr><th>Day</th><th>Start</th><th>End</th><th>Subject</th><th>Section</th><th>Teacher</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr style="text-align: center">
                <td>${r.day || ""}</td>
                <td>${r.start || ""}</td>
                <td>${r.end || ""}</td>
                <td>${r.subject || ""}</td>
                <td>${r.section || ""}</td>
                <td>${r.teacher || ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<p style="margin:8px 0 0">No schedule available.</p>`;

      // Rooms list (click to toggle schedule)
      if (rooms.length) {
        bRooms.innerHTML = rooms.map(r => `
          <div class="row" data-room-id="${r.tag}" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fafafa;cursor:pointer;margin:6px 0">
            <div><strong>${r.name}</strong></div>
            <div class="badge" style="font-size:12px;padding:2px 8px;border-radius:999px;background:#e5e7eb">Click to view schedule</div>
          </div>
          <div id="sched-${r.tag}" class="hidden" style="display:none"><p>Loading...</p></div>
        `).join("");
      } else {
        bRooms.innerHTML = `<p>No rooms defined for this building yet.</p>`;
      }

      // CR lists
      if (crs.length) {
        bCRs.innerHTML = crs.map(c => `
          <div class="row" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#fafafa;margin:6px 0">
            <div><strong>${c.name}</strong></div>
            <div class="badge" style="font-size:12px;padding:2px 8px;border-radius:999px;background:#e5e7eb">Facility</div>
          </div>
        `).join("");
      } else {
        bCRs.innerHTML = `<p>No CR listed for this building.</p>`;
      }

      // bind toggles
      bdlg.querySelectorAll('[data-room-id]').forEach(row => {
        // row.addEventListener('click', () => {
        //   const tag = row.getAttribute('data-room-id');
        //   const panel = document.getElementById('sched-' + tag);
        //   if (!panel) return;
        //   const isHidden = panel.style.display === 'none' || !panel.style.display;
        //   panel.style.display = isHidden ? 'block' : 'none';
        // });
        row.addEventListener('click', async () => {
        const tag = row.getAttribute('data-room-id');
        const panel = document.getElementById('sched-' + tag);
        if (!panel) return;
        const isHidden = panel.style.display === 'none' || !panel.style.display;

        if (isHidden) {
          panel.style.display = 'block';
          panel.innerHTML = `<p>Loading...</p>`;
          try {
            const res = await fetch(`https://python-ss4m.onrender.com/api/v1/schedules/${tag}`);
            if (!res.ok) throw new Error(`Schedules not found for ${tag}`);
            const schedules = await res.json();
            panel.innerHTML = renderSchedTable(schedules);
          } catch (err) {
            console.error(`❌ Failed to fetch schedules for ${tag}:`, err);
            panel.innerHTML = `<p>Error loading schedules.</p>`;
          }
        } else {
          panel.style.display = 'none';
        }
      });
      });

      if (typeof bdlg.showModal === "function") bdlg.showModal();
      else alert("Rooms and CRs are only available in the modal.\n(Your browser does not support <dialog>.)");
      } catch (err) {
      console.error("❌ Failed to load rooms from API:", err);
      bRooms.innerHTML = `<p>Error loading rooms.</p>`;
      bCRs.innerHTML = "";
      }
    }

    // (Optional legacy dblclick building schedule)
    const dlg   = document.getElementById("schedDlg");
    const title = document.getElementById("schedTitle");
    const body  = document.getElementById("schedBody");
    function openSchedule(b) {
      const rows = scheduleFor(b.id);
      title.textContent = `Schedules — ${b.name}`;
      body.innerHTML = rows && rows.length ? `
        <table>
          <thead><tr>
            <th>Day</th><th>Start</th><th>End</th><th>Subject</th><th>Section</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${r.day || ""}</td>
                <td>${r.start || ""}</td>
                <td>${r.end || ""}</td>
                <td>${r.subject || ""}</td>
                <td>${r.section || ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<p>No schedules for this building.</p>`;
      dlg?.showModal?.();
    }
  } catch (e) {
    console.error(e);
    alert("Failed to load campus map data.\n" + e.message + "\nCheck console for details.");
  }
})();
