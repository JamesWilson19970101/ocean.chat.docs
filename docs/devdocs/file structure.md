## Next.js IM Application Directory Structure

Here's a suggested directory structure for your Next.js IM application using the App Router:

```
/oceanchat
├── /app # Next.js App Router directory
│ ├── /api # API routes (server-side logic)
│ │ └── /auth # Authentication related API endpoints
│ │ ├── /register # Registration logic
│ │ │ └── route.ts # Handles POST requests for user registration
│ │ └── /login # Login logic (you'll add this later)
│ │ └── route.ts # Handles POST requests for user login
│ ├── /(auth) # Route group for authentication pages (no impact on URL path)
│ │ ├── /login # Login page route
│ │ │ └── page.tsx # Login page component
│ │ └── /register # Register page route
│ │ └── page.tsx # --- Register page component (We will create this) ---
│ ├── /(main) # Route group for the main application interface (e.g., protected routes)
│ │ ├── /chat # Main chat interface route
│ │ │ └── [roomId] # room page route
        └── page.tsx # room page component
│ │ │ └── page.tsx # Chat page component
│ │ └── layout.tsx # Layout specific to the chat app section (e.g., sidebar, header)
│ ├── layout.tsx # Root layout (applies to all routes)
│ └── page.tsx # Optional: Your application's landing/home page (if needed)
│ └── globals.css # Global styles (imported in root layout)
├── /components # Reusable UI components (non-shadcn)
│ ├── /auth # Components specific to authentication flows
│ └── /ui # shadcn/ui components (automatically managed)
├── /hooks # Custom React hooks
├── /lib # Utility functions, helpers, constants, types
│ ├── validators.ts # Zod validation schemas
│ └── utils.ts # shadcn/ui utility functions (auto-generated)
├── /public # Static assets (images, fonts, etc.)
│ └── ocean-bg.jpg # Place your background image here
├── /store # State management (e.g., Zustand, Redux Toolkit)
├── next.config.mjs # Next.js configuration file
├── tsconfig.json # TypeScript configuration
├── postcss.config.js # PostCSS configuration (for Tailwind CSS)
├── tailwind.config.ts # Tailwind CSS configuration
└── package.json # Project dependencies and scripts
```

**Explanation:**

- **`/app`**: Core of the Next.js App Router.
- **`/app/api`**: Server-side API endpoints. The `/auth/register/route.ts` will handle the actual user creation logic (e.g., saving to a database).
- **`/(auth)` and `/(main)`**: These are Route Groups. They organize your routes without affecting the URL structure. `(auth)` groups pages like login/register, while `(main)` could group the core authenticated parts of your app.
- **`/components`**: Your custom React components. shadcn/ui components live in `/components/ui`.
- **`/lib`**: Shared functions, type definitions, validation schemas (`zod`), etc.
- **`/public`**: Static files accessible directly via URL (like your background image).
- **`/store`**: If you use a global state management library.
