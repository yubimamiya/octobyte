import React, { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/fire-data';
const CHAT_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/chat';
const ASSESS_URL = import.meta.env.VITE_ASSESS_URL || CHAT_URL.replace(/\/api\/chat\/?$/, '/api/assess');
const RECONNECT_MS = 3000;
const DEFAULT_CENTER = { lng: -120.11, lat: 48.36 }; // Washington State

// Backend zones are [{id, coordinates: [[lng, lat], ...]}]. Convert to a GeoJSON
// FeatureCollection of polygons, closing each ring as GeoJSON requires.
const zonesToGeoJSON = (zones = []) => ({
  type: 'FeatureCollection',
  features: zones
    .filter((zone) => Array.isArray(zone.coordinates) && zone.coordinates.length >= 3)
    .map((zone) => {
      const ring = [...zone.coordinates];
      const [first, last] = [ring[0], ring[ring.length - 1]];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
      return {
        type: 'Feature',
        id: zone.id,
        properties: { id: zone.id },
        geometry: { type: 'Polygon', coordinates: [ring] },
      };
    }),
});

const ZONE_LAYERS = [
  { source: 'red-zones', color: '#ef4444', fillOpacity: 0.35 },
  { source: 'yellow-zones', color: '#facc15', fillOpacity: 0.2 },
];

const addZoneLayers = (map) => {
  ZONE_LAYERS.forEach(({ source, color, fillOpacity }) => {
    map.addSource(source, { type: 'geojson', data: zonesToGeoJSON([]) });
    map.addLayer({
      id: `${source}-fill`,
      type: 'fill',
      source,
      paint: { 'fill-color': color, 'fill-opacity': fillOpacity },
    });
    map.addLayer({
      id: `${source}-outline`,
      type: 'line',
      source,
      paint: { 'line-color': color, 'line-width': 2 },
    });
  });
};

const RISK_STYLES = {
  evacuate: { badge: 'bg-red-600', label: 'EVACUATE' },
  warning: { badge: 'bg-orange-500', label: 'WARNING' },
  watch: { badge: 'bg-yellow-500 text-slate-900', label: 'WATCH' },
  none: { badge: 'bg-emerald-600', label: 'NO THREAT' },
};

// Panel showing the Hermes agent's verdict for the selected point.
const AssessmentPanel = ({ assessment, loading, error, point }) => {
  const style = RISK_STYLES[assessment?.risk_level] || RISK_STYLES.none;
  return (
    <div
      className="absolute bottom-4 left-4 max-w-sm bg-slate-800/95 p-4 rounded-lg shadow-lg z-10 text-sm"
      data-testid="assessment-panel"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="font-bold text-orange-400">Hermes Agent</span>
        {assessment && (
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${style.badge}`} data-testid="risk-badge">
            {style.label}
          </span>
        )}
      </div>
      {point && (
        <p className="text-xs text-gray-400 mb-2">
          {point.lat.toFixed(3)}, {point.lng.toFixed(3)}
          {MAPBOX_TOKEN ? ' · click the map to check another spot' : ''}
        </p>
      )}
      {loading && <p className="text-gray-300">Analyzing fire data…</p>}
      {error && <p className="text-red-400" role="alert">Assessment failed: {error}</p>}
      {assessment && !loading && (
        <>
          <p className="font-semibold text-gray-100">{assessment.headline}</p>
          <p className="text-gray-300 mt-1">{assessment.summary}</p>
          {assessment.recommended_actions?.length > 0 && (
            <ul className="list-disc list-inside mt-2 text-gray-200">
              {assessment.recommended_actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-gray-500 mt-2">
            {assessment.nearest_active_fire_km != null && `Nearest active fire: ${assessment.nearest_active_fire_km} km · `}
            {assessment.source === 'hermes' ? assessment.model : 'offline fallback'}
          </p>
        </>
      )}
    </div>
  );
};

const Map = ({ persona }) => {
  const mapContainer = useRef(null);
  const markerRef = useRef(null);
  const mapRef = useRef(null);
  const requestId = useRef(0);

  const [point, setPoint] = useState(DEFAULT_CENTER);
  const [assessment, setAssessment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Ask the Hermes agent about a location. Latest request wins.
  const assess = useCallback(
    async ({ lat, lng }) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(ASSESS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lng, persona }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (id === requestId.current) setAssessment(data);
      } catch (err) {
        if (id === requestId.current) setError(err.message);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [persona]
  );

  // Re-assess the current point whenever it or the persona changes.
  useEffect(() => {
    assess(point);
  }, [point, assess]);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !mapContainer.current) return undefined;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: 10,
    });
    mapRef.current = map;

    let ws = null;
    let reconnectTimer = null;
    let disposed = false;

    const applyZones = (data) => {
      const red = map.getSource('red-zones');
      const yellow = map.getSource('yellow-zones');
      if (red) red.setData(zonesToGeoJSON(data.red_zones));
      if (yellow) yellow.setData(zonesToGeoJSON(data.yellow_zones));
    };

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(WS_URL);
      ws.onmessage = (event) => {
        try {
          applyZones(JSON.parse(event.data));
        } catch (err) {
          console.error('Bad fire data payload', err);
        }
      };
      ws.onclose = () => {
        if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };
      ws.onerror = () => ws.close();
    };

    map.on('load', () => {
      addZoneLayers(map);
      connect();
      markerRef.current = new mapboxgl.Marker({ color: '#f97316' })
        .setLngLat([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat])
        .addTo(map);
    });

    // Clicking the map asks Hermes about that spot.
    map.on('click', (event) => {
      const { lng, lat } = event.lngLat;
      markerRef.current?.setLngLat([lng, lat]);
      setPoint({ lng, lat });
    });

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const panel = <AssessmentPanel assessment={assessment} loading={loading} error={error} point={point} />;

  if (!MAPBOX_TOKEN) {
    return (
      <div className="relative w-full h-full">
        <div
          className="w-full h-full flex items-center justify-center text-center text-gray-400 text-sm p-8"
          data-testid="map-missing-token"
        >
          Map unavailable: set VITE_MAPBOX_TOKEN in frontend/.env to load Mapbox.
        </div>
        {panel}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />
      {panel}
    </div>
  );
};

export default Map;
