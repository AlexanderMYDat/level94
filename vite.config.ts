import { defineConfig } from 'vite';

// Rutas relativas en dist/: el juego funciona igual en la raíz de un bucket que en una subcarpeta (§11.8)
export default defineConfig({ base: './' });
