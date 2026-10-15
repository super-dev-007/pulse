"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoJSONSource, Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import { handleFor, heartbeatFor } from "@/lib/identity";
import {
  circlePolygon,
  distanceKm,
  formatDistance,
  nightPolygon,
  solarTime,
  sunElevation,
} from "@/lib/sky";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
// Others see you somewhere within this radius of where you really are.
const PRIVACY_RADIUS_KM = 3;
const SECONDS_PER_SPIN = 120;

type LatLng = { lat: number; lng: number };

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function WorldMap({
  peers,
  me,
  onPeerClick,
  canConnect,
}: {
  peers: PeerDot[];
  me: LatLng | null; // real location — only ever rendered locally
  onPeerClick: (id: string) => void;
  canConnect: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const meMarkerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  // Marker click handlers are bound once, so read the live click handler,
  // connectability and location through refs (synced in an effect).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  const meRef = useRef(me);
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
    meRef.current = me;
  });

  // Initialise the map once: a slowly turning night globe.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;
    let nightTimer: ReturnType<typeof setInterval> | undefined;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/dark-v11",
        projection: "globe",
        center: [-30, 25],
        zoom: 1.5,
        attributionControl: true,
        logoPosition: "bottom-right",
      });
      mapRef.current = map;

      map.on("style.load", () => {
        map.setFog({
          color: "rgb(14, 16, 28)",
          "high-color": "rgb(36, 22, 70)",
          "horizon-blend": 0.06,
          "space-color": "rgb(4, 5, 10)",
          "star-intensity": 0.65,
        });

        // The night side of the planet, under the labels.
        const firstSymbol = map
          .getStyle()
          .layers?.find((l) => l.type === "symbol")?.id;
        map.addSource("night", { type: "geojson", data: nightPolygon(new Date()) });
        map.addLayer(
          {
            id: "night",
            type: "fill",
            source: "night",
            paint: { "fill-color": "#01020a", "fill-opacity": 0.42 },
          },
          firstSymbol,
        );
        nightTimer = setInterval(() => {
          (map.getSource("night") as GeoJSONSource | undefined)?.setData(
            nightPolygon(new Date()),
          );
        }, 60_000);

        // Your privacy radius (visible once you zoom in).
        map.addSource("privacy", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "privacy-fill",
          type: "fill",
          source: "privacy",
          paint: { "fill-color": "#ff4f7b", "fill-opacity": 0.07 },
        });
        map.addLayer({
          id: "privacy-line",
          type: "line",
          source: "privacy",
          paint: {
            "line-color": "#ff4f7b",
            "line-opacity": 0.6,
            "line-width": 1.5,
            "line-dasharray": [2, 2],
          },
        });
      });

      // Spin until the user is placed on the map (or grabs the globe).
      let interacting = false;
      const spin = () => {
        if (cancelled || meRef.current || interacting || prefersReducedMotion()) {
          return;
        }
        if (map.getZoom() > 3) return;
        const center = map.getCenter();
        center.lng -= 360 / SECONDS_PER_SPIN;
        map.easeTo({ center, duration: 1000, easing: (t) => t });
      };
      map.on("mousedown", () => (interacting = true));
      map.on("touchstart", () => (interacting = true));
      map.on("mouseup", () => {
        interacting = false;
        spin();
      });
      map.on("touchend", () => {
        interacting = false;
        spin();
      });
      map.on("moveend", spin);

      map.on("load", () => {
        if (cancelled) return;
        setReady(true);
        spin();
      });
    })();

    return () => {
      cancelled = true;
      if (nightTimer) clearInterval(nightTimer);
      markers.forEach((m) => m.remove());
      markers.clear();
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Once we know where the user is: fly down to them and pin "You".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!meMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "me";
        el.innerHTML =
          '<span class="me-ring"></span><span class="me-ring"></span><span class="me-core"></span><span class="me-label">You</span>';
        meMarkerRef.current = new mapboxgl.Marker({ element: el })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
        const target = { center: [me.lng, me.lat] as [number, number], zoom: 3.4 };
        if (prefersReducedMotion()) map.jumpTo(target);
        else map.flyTo({ ...target, duration: 4200, curve: 1.6, essential: true });
      } else {
        meMarkerRef.current.setLngLat([me.lng, me.lat]);
      }
      (map.getSource("privacy") as GeoJSONSource | undefined)?.setData(
        circlePolygon(me, PRIVACY_RADIUS_KM),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [me, ready]);

  // Reconcile markers whenever the peer list changes (or the map becomes ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const markers = markersRef.current;
      const seen = new Set<string>();
      const now = new Date();

      for (const peer of peers) {
        seen.add(peer.id);
        let marker = markers.get(peer.id);
        if (!marker) {
          const el = createPeerElement(peer.id, (id) => {
            if (canConnectRef.current) onPeerClickRef.current(id);
          });
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        } else {
          // A peer that re-joined gets a fresh offset — follow it.
          marker.setLngLat([peer.lng, peer.lat]);
        }
        updatePeerElement(marker.getElement(), peer, meRef.current, now);
      }

      // Drop markers for peers that went offline / got filtered out.
      for (const [id, marker] of markers) {
        if (!seen.has(id)) {
          marker.remove();
          markers.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-space" />

      {!TOKEN && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center">
          <p className="glass max-w-md rounded-2xl p-5 text-sm text-white/80">
            Set <code className="text-pulse-soft">NEXT_PUBLIC_MAPBOX_TOKEN</code>{" "}
            in <code>.env</code> to load the map.
          </p>
        </div>
      )}
    </div>
  );
}

// One stranger's marker: a heartbeat ring, a glowing core, a hover card and
// a one-off arrival ripple.
function createPeerElement(id: string, onClick: (id: string) => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "peer";
  el.dataset.peerId = id;
  const beat = heartbeatFor(id);
  el.style.setProperty("--beat", `${beat.duration}s`);
  el.style.setProperty("--beat-delay", `${beat.delay}s`);
  el.innerHTML =
    '<span class="peer-arrive"></span><span class="peer-ring"></span><span class="peer-core"></span><span class="peer-tip"></span>';
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el.dataset.busy !== "true") onClick(id);
  });
  setTimeout(() => el.querySelector(".peer-arrive")?.remove(), 1700);
  return el;
}

// Busy state, accessible name and hover card ("Amber Fox · ~840 km away ·
// ≈3:12 AM there") for one peer marker. Only touches the DOM when it changed.
function updatePeerElement(
  el: HTMLElement,
  peer: PeerDot,
  me: LatLng | null,
  now: Date,
) {
  const busy = String(peer.busy);
  if (el.dataset.busy !== busy) el.dataset.busy = busy;

  const name = handleFor(peer.id);
  const night = sunElevation(peer.lat, peer.lng, now) < 0;
  const when = `${night ? "☾" : "☀"} ≈${solarTime(peer.lng, now)} there`;
  const where = me ? formatDistance(distanceKm(me, peer)) : "";
  const status = peer.busy ? "In a conversation" : "Tap to connect";
  const key = `${name}|${when}|${where}|${status}`;
  if (el.dataset.tip === key) return;
  el.dataset.tip = key;

  el.setAttribute(
    "aria-label",
    `${name}${where ? `, ${where}` : ""}. ${status}.`,
  );
  const tip = el.querySelector(".peer-tip");
  if (tip) {
    tip.innerHTML = "";
    const title = document.createElement("b");
    title.textContent = name;
    const line = document.createElement("span");
    line.textContent = [where, when].filter(Boolean).join(" · ");
    const action = document.createElement("span");
    action.textContent = status;
    action.style.display = "block";
    action.style.color = peer.busy ? "rgb(238 240 247 / 0.45)" : "#ffd27a";
    tip.append(title, line, action);
  }
}
