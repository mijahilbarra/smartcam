<script setup>
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
    <!-- Main Left Pane (Canvas o Contenido Principal) -->
    <div class="lg:col-span-8 flex flex-col gap-4">
      <slot name="main" />
    </div>

    <!-- Side Right Pane (Feed, Controles o Sidebar) -->
    <div class="lg:col-span-4 flex flex-col gap-4">
      <slot name="side" />
    </div>
  </div>
</template>
