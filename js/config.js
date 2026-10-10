/*
 * Configuração de conexão.
 *  - Rodando com "node server.js": deixe as duas linhas do Supabase vazias.
 *  - Hospedagem estática com Supabase: preencha a URL do projeto e a chave "anon public"
 *    (Supabase > Project Settings > API). A chave anon é pública por design; a proteção
 *    está nas políticas RLS do supabase/schema.sql. NUNCA coloque a chave "service_role" aqui.
 */
window.BJ_CONFIG = {
  supabaseUrl: 'https://ommnhtctnndswiysbacx.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbW5odGN0bm5kc3dpeXNiYWN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1OTcyMDYsImV4cCI6MjEwNzE3MzIwNn0.xuAlivnP4D1HYOGaeqWgBit_cRDl1mjiNpWeUidXlPk',
  // Crédito do rodapé: cole aqui o link do perfil no LinkedIn (https://www.linkedin.com/in/...).
  linkedinUrl: 'https://www.linkedin.com/in/wallacesilveira/',
};
