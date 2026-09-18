import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/fire-data';
const RECONNECT_MS = 3000;

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

const Map = () => {
  const mapContainer = useRef(null);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !mapContainer.current) return undefined;

    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-120.11, 48.36], // Washington State
      zoom: 10,
    });

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
    });

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      map.remove();
    };
  }, []);

  if (!MAPBOX_TOKEN) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-center text-gray-400 text-sm p-8"
        data-testid="map-missing-token"
      >
        Map unavailable: set VITE_MAPBOX_TOKEN in frontend/.env to load Mapbox.
      </div>
    );
  }

  return <div ref={mapContainer} className="w-full h-full" />;
};

export default Map;
