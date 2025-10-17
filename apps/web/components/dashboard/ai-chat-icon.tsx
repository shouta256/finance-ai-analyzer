import React from 'react';

interface AiChatIconProps {
  className?: string;
}

export function AiChatIcon({ className }: AiChatIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={1.8}
      className={className}
    >
      <defs>
        <linearGradient id="gemini-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="50%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>

      <g stroke="url(#gemini-gradient)">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.5 6.5L16 5l.5 1.5L18 7l-1.5.5L16 9l-.5-1.5L14 7l1.5-.5zM20 2L19 4l-1-2 1-2 1 2z"
        />
      </g>
    </svg>
  );
}