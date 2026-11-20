/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: 'rgb(var(--p-50) / <alpha-value>)', 100: 'rgb(var(--p-100) / <alpha-value>)', 200: 'rgb(var(--p-200) / <alpha-value>)',
          300: 'rgb(var(--p-300) / <alpha-value>)', 400: 'rgb(var(--p-400) / <alpha-value>)', 500: 'rgb(var(--p-500) / <alpha-value>)',
          600: 'rgb(var(--p-600) / <alpha-value>)', 700: 'rgb(var(--p-700) / <alpha-value>)', 800: 'rgb(var(--p-800) / <alpha-value>)',
          900: 'rgb(var(--p-900) / <alpha-value>)',
        },
        secondary: {
          50: '#F0F0FF',
          100: '#E0E0FF',
          500: '#5856D6',
          600: '#4644AD',
          700: '#353384',
        },
        success: {
          50: '#E8F9EC',
          100: '#D1F3D9',
          500: '#34C759',
          600: '#2AA047',
          700: '#1F7935',
        },
        warning: {
          50: '#FFF4E5',
          100: '#FFE9CC',
          500: '#FF9500',
          600: '#CC7700',
          700: '#995900',
        },
        error: {
          50: '#FFE8E6',
          100: '#FFD1CC',
          500: '#FF3B30',
          600: '#CC2F26',
          700: '#99231D',
        },
        gray: {
          50: '#FAFAFA',
          100: '#F5F5F5',
          200: '#EEEEEE',
          300: '#E0E0E0',
          400: '#BDBDBD',
          500: '#9E9E9E',
          600: '#757575',
          700: '#616161',
          800: '#424242',
          900: '#212121',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}