import React, { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/fire-data';
const CHAT_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/chat';
const ASSESS_URL = import.meta.env.VITE_ASSESS_URL || CHAT_URL.replace(/\/api\/chat\/?$/, '/api/assess');
const RECONNECT_MS = 3000;
const DEFAULT_CENTER = { lng: -120.11, lat: 48.36 }; // Washington State
const INITIAL_SIMULATED_TIME = '2018-11-08T11:00:00';
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

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

const routeGeoJSON = (geometry) => ({
  type: 'Feature',
  properties: {},
  geometry,
});

const emptyRouteGeoJSON = () => ({ type: 'FeatureCollection', features: [] });

const distanceSquared = (first, second) => {
  const latitudeScale = Math.cos((first[1] * Math.PI) / 180);
  const longitudeDistance = (first[0] - second[0]) * latitudeScale;
  const latitudeDistance = first[1] - second[1];
  return longitudeDistance ** 2 + latitudeDistance ** 2;
};

const routeFireRisk = (route, firePoints) => {
  const coordinates = route.geometry?.coordinates || [];
  if (!coordinates.length || !firePoints.length) return 0;
  return Math.min(
    ...firePoints.map((point) =>
      Math.min(...coordinates.map((coordinate) => distanceSquared(coordinate, point)))
    )
  );
};

const chooseSafestRoute = (routes, firePoints) => routes
  .map((route, index) => ({ route, index, fireRisk: routeFireRisk(route, firePoints) }))
  .sort((first, second) => second.fireRisk - first.fireRisk)[0];

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

const RouteSearch = ({ onSearch, onRoute }) => {
  const [meQuery, setMeQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [meLocation, setMeLocation] = useState(null);
  const [destinationLocation, setDestinationLocation] = useState(null);
  const [results, setResults] = useState({ field: null, locations: [] });
  const [isSearching, setIsSearching] = useState(false);
  const [isRouting, setIsRouting] = useState(false);
  const [error, setError] = useState('');

  const geocode = async (query, field) => {
    const response = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${MAPBOX_TOKEN}&limit=5`,
    );
    if (!response.ok) throw new Error('Location search failed');
    const data = await response.json();
    setResults({ field, locations: data.features || [] });
    if (!data.features?.length) throw new Error('No locations found');
  };

  const searchField = async (field) => {
    const query = field === 'me' ? meQuery.trim() : destinationQuery.trim();
    if (!query) return;
    setIsSearching(true);
    setError('');
    try {
      await geocode(query, field);
    } catch (searchError) {
      setResults({ field: null, locations: [] });
      setError(searchError.message);
    } finally {
      setIsSearching(false);
    }
  };

  const selectLocation = (location) => {
    const selected = { lng: location.center[0], lat: location.center[1], label: location.place_name };
    if (results.field === 'me') {
      setMeQuery(location.place_name);
      setMeLocation(selected);
    } else {
      setDestinationQuery(location.place_name);
      setDestinationLocation(selected);
    }
    setResults({ field: null, locations: [] });
    setError('');
  };

  const submitSearch = async (event) => {
    event.preventDefault();
    if (meLocation || destinationLocation) {
      onSearch(meLocation || destinationLocation);
      return;
    }
    await searchField('me');
  };

  const submitRoute = async () => {
    if (!meLocation || !destinationLocation) return;
    setIsRouting(true);
    setError('');
    try {
      await onRoute(meLocation, destinationLocation);
    } catch (routeError) {
      setError(routeError.message);
    } finally {
      setIsRouting(false);
    }
  };

  const resultList = results.locations.length > 0 && (
    <div className="mt-1 overflow-hidden rounded-lg bg-slate-900/95 shadow-xl">
      {results.locations.map((location) => (
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
  );

  return (
    <div className="absolute top-4 right-4 z-10 w-[min(390px,calc(100%-2rem))] rounded-lg bg-slate-900/95 p-2 shadow-xl">
      <form onSubmit={submitSearch} className="space-y-2">
        <input value={meQuery} onChange={(event) => { setMeQuery(event.target.value); setMeLocation(null); }} onBlur={() => searchField('me')} placeholder="Me: enter an address" aria-label="Your location" className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-orange-500" />
        {results.field === 'me' && resultList}
        <input value={destinationQuery} onChange={(event) => { setDestinationQuery(event.target.value); setDestinationLocation(null); }} onBlur={() => searchField('destination')} placeholder="Destination: enter an address" aria-label="Destination location" className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-orange-500" />
        {results.field === 'destination' && resultList}
        <div className="flex gap-2">
          <button type="submit" disabled={isSearching || (!meQuery.trim() && !destinationQuery.trim())} className="flex-1 rounded bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50">{isSearching ? 'Searching...' : 'Search'}</button>
          <button type="button" onClick={submitRoute} disabled={isRouting || !meLocation || !destinationLocation} className="flex-1 rounded bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">{isRouting ? 'Routing...' : 'Route'}</button>
        </div>
      </form>
      {error && <p className="mt-2 rounded bg-red-950/95 px-3 py-2 text-xs text-red-200">{error}</p>}
      <p className="mt-2 text-[11px] text-slate-400">Search one address for fire risk, or set both addresses for a safer street route.</p>
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
  const [routeStatus, setRouteStatus] = useState('');
  const firePointsRef = useRef([]);

  const setFirePoints = (data) => {
    const collections = hotspotCollections(data);
    const hotspotPoints = collections.red.features.map((feature) => feature.geometry.coordinates);
    const zonePoints = (data.red_zones || []).flatMap((zone) => zone.coordinates || []);
    firePointsRef.current = [...hotspotPoints, ...zonePoints];
    return collections;
  };

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

  const buildSafeRoute = useCallback(async (origin, destination) => {
    const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    const response = await fetch(
      `${DIRECTIONS_URL}/${coordinates}?alternatives=true&geometries=geojson&overview=full&steps=true&access_token=${MAPBOX_TOKEN}`,
    );
    if (!response.ok) throw new Error('Street routing failed');
    const data = await response.json();
    if (!data.routes?.length) throw new Error('No driving route found');

    const selected = chooseSafestRoute(data.routes, firePointsRef.current);
    mapRef.current?.getSource('safe-route')?.setData(routeGeoJSON(selected.route.geometry));
    mapRef.current?.fitBounds(
      [[origin.lng, origin.lat], [destination.lng, destination.lat]],
      { padding: 100, duration: 1000 },
    );
    focusLocation(origin);
    setRouteStatus(
      firePointsRef.current.length
        ? `Safest street route selected from ${data.routes.length} options, avoiding red fire data.`
        : 'Street route selected. No red fire points are available in the current feed.',
    );
  }, [focusLocation]);

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
      if (data.simulated_time) setSimulatedTime(data.simulated_time);
      const red = map.getSource('red-zones');
      const yellow = map.getSource('yellow-zones');
      if (red) red.setData(zonesToGeoJSON(data.red_zones));
      if (yellow) yellow.setData(zonesToGeoJSON(data.yellow_zones));
      const hotspots = setFirePoints(data);
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
      map.addSource('safe-route', { type: 'geojson', data: emptyRouteGeoJSON() });
      map.addLayer({
        id: 'safe-route-line',
        type: 'line',
        source: 'safe-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 5, 'line-opacity': 0.9 },
      });
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
      <RouteSearch onSearch={handleSearchSelect} onRoute={buildSafeRoute} />
      {clockBadge}
      <div ref={mapContainer} className="h-full w-full" />
      {routeStatus && <div className="absolute bottom-4 right-4 z-20 mb-14 max-w-sm rounded-lg bg-slate-900/95 px-3 py-2 text-xs text-sky-200 shadow-xl">{routeStatus}</div>}
      {panel}
    </div>
  );
};

export default Map;
