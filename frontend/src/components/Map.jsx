import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const Map = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const ws = useRef(null);
  const marker = useRef(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  const searchLocation = async (event) => {
    event?.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery || !map.current) return;

    setIsSearching(true);
    setSearchError('');
    try {
      const token = import.meta.env.VITE_MAPBOX_TOKEN;
      const response = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(trimmedQuery)}.json?access_token=${token}&limit=5`,
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
    map.current?.flyTo({ center: [longitude, latitude], zoom: 11, essential: true });
    marker.current?.remove();
    marker.current = new mapboxgl.Marker({ color: '#f97316' })
      .setLngLat([longitude, latitude])
      .setPopup(new mapboxgl.Popup({ offset: 24 }).setText(location.place_name))
      .addTo(map.current);
    marker.current.togglePopup();
    setQuery(location.place_name);
    setResults([]);
    setSearchError('');
  };

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
      marker.current?.remove();
    };
  }, []);

  return (
    <div className="relative w-full h-full">
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
      <div ref={mapContainer} className="h-full w-full" />
    </div>
  );
};

export default Map;