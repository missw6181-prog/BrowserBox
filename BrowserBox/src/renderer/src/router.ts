import { createRouter, createWebHashHistory } from 'vue-router'
import SetupView from './views/SetupView.vue'
import EnvironmentsView from './views/EnvironmentsView.vue'
import ProxiesView from './views/ProxiesView.vue'
import BrowserView from './views/BrowserView.vue'
import SettingsView from './views/SettingsView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/setup', name: 'setup', component: SetupView },
    { path: '/', name: 'environments', component: EnvironmentsView },
    { path: '/proxies', name: 'proxies', component: ProxiesView },
    { path: '/browser', name: 'browser', component: BrowserView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})

export default router
