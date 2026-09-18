import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { TextStreamChatTransport } from 'ai';

// Text content of a UI message. The AI SDK stores message content as `parts`.
const messageText = (message) =>
  (message.parts || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

const Chatbot = ({ persona }) => {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/chat';

  // Keep the latest persona reachable from the transport without recreating it.
  const personaRef = useRef(persona);
  personaRef.current = persona;

  // The backend streams plain text, so use the text transport (not the default data protocol).
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: apiUrl,
        body: () => ({ persona: personaRef.current }),
      }),
    [apiUrl]
  );

  const { messages, sendMessage, status, error } = useChat({ transport });
  const [input, setInput] = useState('');
  const isBusy = status === 'submitted' || status === 'streaming';

  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput('');
  };

  return (
    <div className="flex flex-col h-full p-4">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-orange-400">Emergency AI Assistant</h2>
        <p className="text-xs text-gray-400">
          Ask about routes, safety, or staging areas.
          {persona && <span className="ml-1 text-orange-300">Persona: {persona}</span>}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 mb-4 pr-2" data-testid="messages">
        {messages.map((m) => (
          <div
            key={m.id}
            data-role={m.role}
            className={`p-3 rounded-lg text-sm whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-blue-600 self-end text-white' : 'bg-slate-700 self-start text-gray-100'
            }`}
          >
            <span className="font-bold block mb-1">{m.role === 'user' ? 'You' : 'Agent'}</span>
            {messageText(m)}
          </div>
        ))}
        {status === 'submitted' && <div className="text-gray-400 text-sm">Agent is analyzing...</div>}
        {error && (
          <div className="text-red-400 text-sm" role="alert">
            Could not reach the agent: {error.message}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          className="flex-1 bg-slate-700 text-white rounded p-3 outline-none focus:ring-2 focus:ring-orange-500"
          value={input}
          placeholder="e.g., Is Highway 20 open?"
          onChange={(event) => setInput(event.target.value)}
          disabled={isBusy}
          aria-label="Message"
        />
        <button
          type="submit"
          disabled={isBusy || !input.trim()}
          className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-2 px-4 rounded transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
};

export default Chatbot;
