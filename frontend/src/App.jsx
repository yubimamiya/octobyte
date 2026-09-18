import React from 'react';
import Map from './components/Map';
import Chatbot from './components/Chatbot';

function App() {
  return (
    <div className="flex h-screen w-full bg-slate-900 text-white overflow-hidden">
      {/* Map Section (Left) */}
      <div className="flex-grow relative">
        <Map />
        {/* Mock Persona Selector for Demo */}
        <div className="absolute top-4 left-4 bg-slate-800 p-4 rounded-lg shadow-lg z-10">
          <h1 className="text-xl font-bold mb-2 text-orange-500">LiveFire Agent</h1>
          <p className="text-sm text-gray-300">Simulating: Washington State</p>
          <div className="mt-4 flex flex-col gap-2">
            <button className="bg-slate-700 px-3 py-1 rounded hover:bg-slate-600">👤 Citizen</button>
            <button className="bg-slate-700 px-3 py-1 rounded hover:bg-slate-600">🧑‍🍼 Caregiver</button>
            <button className="bg-slate-700 px-3 py-1 rounded hover:bg-slate-600">🚒 Firefighter</button>
          </div>
        </div>
      </div>

      {/* AI Chatbot Section (Right) */}
      <div className="w-[400px] border-l border-slate-700 flex flex-col bg-slate-800 shadow-2xl">
        <Chatbot />
      </div>
    </div>
  );
}

export default App;