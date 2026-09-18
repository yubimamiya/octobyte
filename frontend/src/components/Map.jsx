import React, { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/fire-data';
const CHAT_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/chat';
const ASSESS_URL = import.meta.env.VITE_ASSESS_URL || CHAT_URL.replace(/\/api\/chat\/?$/, '/api/assess');
const RECONNECT_MS = 3000;
// Paradise, California: centre of the Camp Fire incident data in backend/data.
const DEFAULT_CENTER = { lng: -121.62, lat: 39.76 };
const DEFAULT_ZOOM = 12;
const INITIAL_SIMULATED_TIME = '2018-11-08T11:00:00';

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

const hotspotsToGeoJSON = (hotspots = []) => ({
  type: 'FeatureCollection',
  features: hotspots.flatMap((hotspot, index) => {
    const latitude = Number(hotspot.latitude ?? hotspot.lat ?? hotspot.attr_InitialLatitude);
    const longitude = Number(hotspot.longitude ?? hotspot.lon ?? hotspot.lng ?? hotspot.attr_InitialLongitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      type: 'Feature',
      properties: { ...hotspot, id: hotspot.id ?? hotspot.OBJECTID ?? `hotspot-${index}` },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    }];
  }),
});

const hotspotCollections = (data) => {
  if (Array.isArray(data.red_hotspots) || Array.isArray(data.yellow_hotspots)) {
    return {
      red: hotspotsToGeoJSON(data.red_hotspots || []),
      yellow: hotspotsToGeoJSON(data.yellow_hotspots || []),
    };
  }

  const records = Array.isArray(data.hotspots) ? data.hotspots : Array.isArray(data.records) ? data.records : [];
  const red = [];
  const yellow = [];
  records.forEach((record) => {
    const classification = String(record.color ?? record.status ?? record.classification ?? '').toLowerCase();
    (classification === 'red' || classification === 'confirmed' ? red : yellow).push(record);
  });
  return { red: hotspotsToGeoJSON(red), yellow: hotspotsToGeoJSON(yellow) };
};

const addHotspotLayers = (map) => {
  map.addSource('red-hotspots', { type: 'geojson', data: hotspotsToGeoJSON([]) });
  map.addSource('yellow-hotspots', { type: 'geojson', data: hotspotsToGeoJSON([]) });
  map.addLayer({
    id: 'yellow-hotspots',
    type: 'circle',
    source: 'yellow-hotspots',
    paint: { 'circle-color': '#facc15', 'circle-radius': 6, 'circle-stroke-color': '#713f12', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'red-hotspots',
    type: 'circle',
    source: 'red-hotspots',
    paint: { 'circle-color': '#ef4444', 'circle-radius': 7, 'circle-stroke-color': '#450a0a', 'circle-stroke-width': 2 },
  });
};

const formatSimulatedTime = (value) => {
  if (!value) return 'Waiting for backend clock...';
  return new Date(value).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
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
          {point.label ? `${point.label} · ` : ''}
          {point.lat.toFixed(3)}, {point.lng.toFixed(3)}
          {MAPBOX_TOKEN ? ' · click the map or search to check another spot' : ''}
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

// Mapbox geocoding search box. Selecting a result reports it via onSelect.
const LocationSearch = ({ onSelect }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const searchLocation = async (event) => {
    event?.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    setIsSearching(true);
    setSearchError('');
    try {
      const response = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(trimmedQuery)}.json?access_token=${MAPBOX_TOKEN}&limit=5`,
      );
      if (!response.ok) throw new Error('Location search failed');
      const data = await response.json();
      setResults(data.features || []);
      if (!data.features?.length) setSearchError('No locations found');
    } catch (error) {
      setResults([]);
      setSearchError(error.message);
    } finally {
      setIsSearching(false);
    }
  };

  const selectLocation = (location) => {
    const [longitude, latitude] = location.center;
    onSelect({ lng: longitude, lat: latitude, label: location.place_name });
    setQuery(location.place_name);
    setResults([]);
    setSearchError('');
  };

  return (
    <div className="absolute top-4 right-4 z-10 w-[min(360px,calc(100%-2rem))]">
      <form onSubmit={searchLocation} className="flex gap-2 rounded-lg bg-slate-900/95 p-2 shadow-xl">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a location"
          aria-label="Search a location"
          className="min-w-0 flex-1 rounded bg-slate-700 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-orange-500"
        />
        <button
          type="submit"
          disabled={isSearching || !query.trim()}
          className="rounded bg-orange-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSearching ? '...' : 'Search'}
        </button>
      </form>
      {searchError && <p className="mt-1 rounded bg-red-950/95 px-3 py-2 text-xs text-red-200">{searchError}</p>}
      {results.length > 0 && (
        <div className="mt-1 overflow-hidden rounded-lg bg-slate-900/95 shadow-xl">
          {results.map((location) => (
            <button
              type="button"
              key={location.id}
              onClick={() => selectLocation(location)}
              className="block w-full border-b border-slate-700 px-3 py-2 text-left text-sm text-slate-200 last:border-0 hover:bg-slate-700"
            >
              {location.place_name}
            </button>
          ))}
        </div>
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
  const [simulatedTime, setSimulatedTime] = useState(INITIAL_SIMULATED_TIME);

  useEffect(() => {
    let disposed = false;

    const updateClock = async () => {
      try {
        const response = await fetch(`${CHAT_URL.replace(/\/api\/chat\/?$/, '')}/api/time`);
        if (!response.ok) return;
        const data = await response.json();
        if (!disposed) setSimulatedTime(data.simulated_time);
      } catch {
        // The websocket update will provide the clock when the backend is connected.
      }
    };

    updateClock();
    const interval = window.setInterval(updateClock, 60000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

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

  // Move the marker (and optional popup) to a location and assess it.
  const focusLocation = useCallback(({ lng, lat, label }) => {
    const map = mapRef.current;
    if (map && markerRef.current) {
      markerRef.current.setLngLat([lng, lat]);
      const popup = markerRef.current.getPopup();
      if (label) {
        (popup || markerRef.current.setPopup(new mapboxgl.Popup({ offset: 24 })).getPopup()).setText(label);
        if (!markerRef.current.getPopup().isOpen()) markerRef.current.togglePopup();
      } else if (popup?.isOpen()) {
        markerRef.current.togglePopup();
      }
    }
    setPoint({ lng, lat, label });
  }, []);

  // A search result flies the map there before assessing.
  const handleSearchSelect = useCallback(
    (location) => {
      mapRef.current?.flyTo({ center: [location.lng, location.lat], zoom: 11, essential: true });
      focusLocation(location);
    },
    [focusLocation]
  );

  useEffect(() => {
    if (!MAPBOX_TOKEN || !mapContainer.current) return undefined;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
      zoom: DEFAULT_ZOOM,
    });
    mapRef.current = map;

    let ws = null;
    let reconnectTimer = null;
    let disposed = false;

    const applyZones = (data) => {
      if (data.simulated_time) setSimulatedTime(data.simulated_time);
      const red = map.getSource('red-zones');
      const yellow = map.getSource('yellow-zones');
      if (red) red.setData(zonesToGeoJSON(data.red_zones));
      if (yellow) yellow.setData(zonesToGeoJSON(data.yellow_zones));
      const hotspots = hotspotCollections(data);
      map.getSource('red-hotspots')?.setData(hotspots.red);
      map.getSource('yellow-hotspots')?.setData(hotspots.yellow);
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
      addHotspotLayers(map);
      connect();
      markerRef.current = new mapboxgl.Marker({ color: '#f97316' })
        .setLngLat([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat])
        .addTo(map);
    });

    // Clicking the map asks Hermes about that spot.
    map.on('click', (event) => {
      const { lng, lat } = event.lngLat;
      focusLocation({ lng, lat });
    });

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [focusLocation]);

  const panel = <AssessmentPanel assessment={assessment} loading={loading} error={error} point={point} />;
  const clockBadge = (
    <div className="absolute bottom-4 right-4 z-20 rounded-lg bg-slate-900/95 px-4 py-3 text-sm text-slate-200 shadow-xl">
      <span className="mr-2 text-slate-400">Simulated time</span>
      <span className="text-base font-semibold text-orange-300">{formatSimulatedTime(simulatedTime)}</span>
    </div>
  );

  if (!MAPBOX_TOKEN) {
    return (
      <div className="relative w-full h-full">
        <div
          className="w-full h-full flex items-center justify-center text-center text-gray-400 text-sm p-8"
          data-testid="map-missing-token"
        >
          Map unavailable: set VITE_MAPBOX_TOKEN in frontend/.env to load Mapbox.
        </div>
        {clockBadge}
        {panel}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <LocationSearch onSelect={handleSearchSelect} />
      {clockBadge}
      <div ref={mapContainer} className="h-full w-full" />
      {panel}
    </div>
  );
};

export default Map;
