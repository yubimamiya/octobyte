import React, { useState } from 'react';
import Map from './components/Map';
import Chatbot from './components/Chatbot';

const PERSONAS = [
  { id: 'citizen', label: '👤 Citizen' },
  { id: 'caregiver', label: '🧑‍🍼 Caregiver' },
  { id: 'firefighter', label: '🚒 Firefighter' },
];

function App() {
  const [persona, setPersona] = useState('citizen');

  return (
    <div className="flex h-screen w-full bg-slate-900 text-white overflow-hidden">
      {/* Map Section (Left) */}
      <div className="flex-grow relative">
        <Map persona={persona} />
        {/* Persona Selector */}
        <div className="absolute top-4 left-4 bg-slate-800 p-4 rounded-lg shadow-lg z-10">
          <h1 className="text-xl font-bold mb-2 text-orange-500">LiveFire Agent</h1>
          <p className="text-sm text-gray-300">Simulating: Camp Fire, Paradise CA (Nov 8, 2018)</p>
          <div className="mt-4 flex flex-col gap-2">
            {PERSONAS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPersona(p.id)}
                aria-pressed={persona === p.id}
                className={`px-3 py-1 rounded text-left transition-colors ${
                  persona === p.id ? 'bg-orange-600 text-white' : 'bg-slate-700 hover:bg-slate-600'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-4 text-xs text-gray-400 flex flex-col gap-1">
            <span><span className="inline-block w-3 h-3 bg-red-500/70 mr-2 align-middle" />Active fire</span>
            <span><span className="inline-block w-3 h-3 bg-yellow-400/70 mr-2 align-middle" />High-risk zone</span>
          </div>
        </div>
      </div>

      {/* AI Chatbot Section (Right) */}
      <div className="w-[400px] border-l border-slate-700 flex flex-col bg-slate-800 shadow-2xl">
        <Chatbot persona={persona} />
      </div>
    </div>
  );
}

export default App;
