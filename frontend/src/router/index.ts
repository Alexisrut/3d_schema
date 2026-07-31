import { createRouter, createWebHistory } from 'vue-router'

import { getToken } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: { name: 'projects' } },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/projects',
      name: 'projects',
      component: () => import('@/views/ProjectsView.vue'),
    },
    {
      path: '/projects/:projectId',
      name: 'viewer',
      component: () => import('@/views/ViewerView.vue'),
    },
    {
      // Личный кабинет доступен всем ролям, включая «Читателя».
      path: '/account',
      name: 'account',
      component: () => import('@/views/AccountView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { admin: true },
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'projects' } },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (!auth.isAuthenticated && getToken()) {
    await auth.restore()
  }

  if (to.meta.public) {
    return auth.isAuthenticated && to.name === 'login' ? { name: 'projects' } : true
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.meta.admin && !auth.isAdmin) {
    return { name: 'projects' }
  }

  return true
})

export default router
