/* Conteúdo padrão exibido quando o site é aberto sem servidor/banco (somente leitura). */
window.BJ_DEFAULT_SITE = {
 "config": {
  "nome": "Barbearia do Juan",
  "slogan": "Seu estilo, Nossa assinatura",
  "telefone": "(11) 98811-8988",
  "whatsapp": "5511988118988",
  "endereco": "Ernesto Rothschild, 287",
  "instagram": "@barbeariadojuan_",
  "instagram_url": "https://www.instagram.com/barbeariadojuan_/",
  "desde": "2011",
  "logo": "assets/logo/logo-720.png",
  "hero_foto": "assets/images/hero.jpg",
  "sobre_foto": "assets/images/sobre.jpg",
  "hero_texto": "Desde 2011, cuidando do seu visual com qualidade, respeito e atenção aos detalhes.",
  "servicos_subtitulo": "Qualidade e estilo em cada detalhe.",
  "sobre_titulo": "Mais que uma barbearia, um lugar pra você.",
  "sobre_texto": "Aqui, cada corte é feito com atenção, técnica e respeito ao seu estilo. Nossa missão é fazer você se sentir bem, do jeito que você gosta.",
  "whatsapp_msg": "Olá! Vim pelo site da Barbearia do Juan e gostaria de agendar um horário. Pode me ajudar?",
  "almoco_ativo": "1",
  "almoco_inicio": "12:00",
  "almoco_fim": "13:00",
  "passo_min": "20",
  "antecedencia_min": "30",
  "dias_agenda": "60"
 },
 "servicos": [
  {
   "id": 1,
   "nome": "Corte",
   "descricao": "",
   "duracao_min": 40,
   "preco": 40,
   "foto": "assets/images/servico-corte.jpg",
   "ordem": 1,
   "ativo": true
  },
  {
   "id": 2,
   "nome": "Detalhamento",
   "descricao": "",
   "duracao_min": 20,
   "preco": 20,
   "foto": "assets/images/servico-pezinho.jpg",
   "ordem": 2,
   "ativo": true
  },
  {
   "id": 3,
   "nome": "Barba",
   "descricao": "",
   "duracao_min": 30,
   "preco": 40,
   "foto": "assets/images/servico-barba.jpg",
   "ordem": 3,
   "ativo": true
  },
  {
   "id": 4,
   "nome": "Sobrancelha",
   "descricao": "",
   "duracao_min": 15,
   "preco": 15,
   "foto": "assets/images/servico-sobrancelha.jpg",
   "ordem": 4,
   "ativo": true
  },
  {
   "id": 5,
   "nome": "Alisamento",
   "descricao": "",
   "duracao_min": 60,
   "preco": 50,
   "foto": "assets/images/servico-alisante.jpg",
   "ordem": 5,
   "ativo": true
  },
  {
   "id": 6,
   "nome": "Platinado",
   "descricao": "",
   "duracao_min": 60,
   "preco": 150,
   "foto": "assets/images/servico-platinado.jpg",
   "ordem": 6,
   "ativo": true
  },
  {
   "id": 7,
   "nome": "Luzes",
   "descricao": "",
   "duracao_min": 60,
   "preco": 80,
   "foto": "assets/images/servico-luzes.jpg",
   "ordem": 7,
   "ativo": true
  }
 ],
 "combos": [
  {
   "id": 1,
   "nome": "Corte + Barba",
   "descricao": "O combo perfeito para quem não abre mão do visual completo.",
   "preco": 70,
   "duracao_min": 70,
   "foto": "assets/images/combo-maquinas.jpg",
   "ordem": 1,
   "ativo": true,
   "servico_ids": [
    1,
    3
   ]
  }
 ],
 "horarios": [
  {
   "dia_semana": 0,
   "ativo": false,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 1,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 2,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 3,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 4,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 5,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  },
  {
   "dia_semana": 6,
   "ativo": true,
   "inicio_min": 480,
   "fim_min": 1080
  }
 ],
 "galeria": [
  {
   "id": 1,
   "foto": "assets/images/galeria-1.jpg",
   "legenda": "",
   "ordem": 1,
   "ativo": true
  },
  {
   "id": 2,
   "foto": "assets/images/galeria-2.jpg",
   "legenda": "",
   "ordem": 2,
   "ativo": true
  },
  {
   "id": 3,
   "foto": "assets/images/galeria-3.jpg",
   "legenda": "",
   "ordem": 3,
   "ativo": true
  },
  {
   "id": 4,
   "foto": "assets/images/galeria-4.jpg",
   "legenda": "",
   "ordem": 4,
   "ativo": true
  },
  {
   "id": 5,
   "foto": "assets/images/galeria-5.jpg",
   "legenda": "",
   "ordem": 5,
   "ativo": true
  },
  {
   "id": 6,
   "foto": "assets/images/galeria-6.jpg",
   "legenda": "",
   "ordem": 6,
   "ativo": true
  },
  {
   "id": 7,
   "foto": "assets/images/galeria-7.jpg",
   "legenda": "",
   "ordem": 7,
   "ativo": true
  },
  {
   "id": 8,
   "foto": "assets/images/galeria-8.jpg",
   "legenda": "",
   "ordem": 8,
   "ativo": true
  }
 ]
};
