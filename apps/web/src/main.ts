import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { theme } from './lib/theme.svelte.ts';

theme.apply();

const target = document.getElementById('app');
if (!target) throw new Error('#app root element missing');

mount(App, { target });
