import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// TODO: Insert your Mapbox token here
mapboxgl.accessToken = 'YOUR_MAPBOX_ACCESS_TOKEN';

const Map = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const ws = useRef(null);
  const [zones, setZones] = useState({ red_zones: [], yellow_zones: [] });

  useEffect(() => {
    if (map.current) return; // initialize map only once
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-120.11, 48.36], // Washington State
      zoom: 10
    });

    map.current.on('load', () => {
      // Setup WebSocket connection to backend
      const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/fire-data';
      ws.current = new WebSocket(wsUrl);

      ws.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("Live fire data received:", data);
        // Here you will update Mapbox GeoJSON layers with data.red_zones and data.yellow_zones
        setZones(data);
      };
    });

    return () => {
      if (ws.current) ws.current.close();
    };
  }, []);

  return <div ref={mapContainer} className="w-full h-full" />;
};

export default Map;