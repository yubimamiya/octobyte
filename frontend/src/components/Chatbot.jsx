import React from 'react';
import { useChat } from '@ai-sdk/react';

const Chatbot = () => {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/chat';
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: apiUrl,
  });

  return (
    <div className="flex flex-col h-full p-4">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-orange-400">Emergency AI Assistant</h2>
        <p className="text-xs text-gray-400">Ask about routes, safety, or staging areas.</p>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 mb-4 pr-2">
        {messages.map((m) => (
          <div key={m.id} className={`p-3 rounded-lg text-sm ${m.role === 'user' ? 'bg-blue-600 self-end text-white' : 'bg-slate-700 self-start text-gray-100'}`}>
            <span className="font-bold block mb-1">{m.role === 'user' ? 'You' : 'Agent'}</span>
            {m.content}
          </div>
        ))}
        {isLoading && <div className="text-gray-400 text-sm">Agent is analyzing...</div>}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          className="flex-1 bg-slate-700 text-white rounded p-3 outline-none focus:ring-2 focus:ring-orange-500"
          value={input}
          placeholder="e.g., Is Highway 20 open?"
          onChange={handleInputChange}
          disabled={isLoading}
        />
        <button 
          type="submit" 
          disabled={isLoading}
          className="bg-orange-600 hover:bg-orange-500 text-white font-bold py-2 px-4 rounded transition-colors">
          Send
        </button>
      </form>
    </div>
  );
};

export default Chatbot;