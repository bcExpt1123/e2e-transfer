import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { i18n } from './lib/i18n/index.svelte.ts';
import { theme } from './lib/theme.svelte.ts';

theme.apply();

const target = document.getElementById('app');
if (!target) throw new Error('#app root element missing');

// Language first, so nobody sees a flash of the wrong one. (Not a top-level await: that
// would make the bundler split the entry into many preloaded chunks.)
void i18n.init().then(() => mount(App, { target }));
