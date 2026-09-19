/*
 * Configuração de conexão.
 *  - Rodando com "node server.js": deixe as duas linhas do Supabase vazias.
 *  - Hospedagem estática com Supabase: preencha a URL do projeto e a chave "anon public"
 *    (Supabase > Project Settings > API). A chave anon é pública por design; a proteção
 *    está nas políticas RLS do supabase/schema.sql. NUNCA coloque a chave "service_role" aqui.
 */
window.BJ_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
  // Crédito do rodapé: cole aqui o link do perfil no LinkedIn (https://www.linkedin.com/in/...).
  linkedinUrl: 'https://www.linkedin.com/in/wallacesilveira/',
};
