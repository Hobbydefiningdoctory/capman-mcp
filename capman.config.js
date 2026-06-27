// capman.config.js
// Auto-generated starter config — edit before use

module.exports = {
  app: 'my-app',
  baseUrl: 'https://api.your-app.com',

  // Optional metadata block — used for documentation and provenance
  info: {
    title:       'My App',
    description: 'Brief description of what this app does',
    version:     '1.0.0',
    homepage:    'https://your-app.com',
    contact:     { name: 'Your Name', email: 'you@your-app.com' },
    license:     { name: 'MIT' },
  },

  capabilities: [
    {
      id: 'get_resource',
      name: 'Get a resource',
      description: 'Fetch a specific resource by name, ID, or filter from the app.',
      examples: [
        'Show me the resource details',
        'Find resource by ID',
        'Look up resource by name',
      ],
      params: [
        {
          name: 'resource_id',
          description: 'The ID or name of the resource to fetch',
          required: true,
          source: 'user_query',
        },
      ],
      returns: ['resource', 'metadata'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'GET', path: '/resources/{resource_id}' }],
      },
      privacy: { level: 'public', note: 'No auth required' },
    },

    {
      id: 'navigate_to_screen',
      name: 'Navigate to a screen',
      description: 'Route the user to a specific page or section in the app.',
      examples: [
        'Take me to the dashboard',
        'Open settings',
        'Go to my profile',
      ],
      params: [
        {
          name: 'destination',
          description: 'The screen or page to navigate to',
          required: true,
          source: 'user_query',
        },
      ],
      returns: ['deep_link'],
      resolver: { type: 'nav', destination: '{destination}' },
      privacy: { level: 'public' },
    },

    {
      id: 'get_user_data',
      name: 'Get user data',
      description: 'Retrieve data belonging to the currently authenticated user.',
      examples: [
        'Show my account details',
        'What is my current plan?',
        'Show my recent activity',
      ],
      params: [
        {
          name: 'user_id',
          description: 'Current user ID',
          required: true,
          source: 'session',
        },
      ],
      returns: ['user_data'],
      resolver: {
        type: 'api',
        endpoints: [{ method: 'GET', path: '/users/{user_id}' }],
      },
      privacy: { level: 'user_owned', note: 'Requires auth — scoped to current user only' },
    },
  ],
}
