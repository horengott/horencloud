const slides = [
    {
        title: 'Welcome to Horen Cloud',
        desc: 'Tu vida digital, segura y siempre a tu alcance.',
        avatar: 'img/avatars/avatar_1.png'
    },
    {
        title: 'Tus recuerdos intactos',
        desc: 'Guarda tus fotos y videos con la mejor calidad.',
        avatar: 'img/avatars/avatar_2.png'
    },
    {
        title: 'Magia con IA integrada',
        desc: 'Elimina fondos, mejora la calidad y transforma tus fotos en segundos.',
        avatar: 'img/avatars/avatar_3.png'
    },
    {
        title: 'Comparte fácilmente',
        desc: 'Envía tus archivos a quien quieras sin salir de la app.',
        avatar: 'img/avatars/avatar_1.png'
    }
];

let currentSlide = 0;
const API_BASE = 'https://tu-backend-url.com'; 

const onboardingScreen = document.getElementById('onboarding-screen');
const mainScreen = document.getElementById('main-screen');
const titleEl = document.getElementById('slide-title');
const descEl = document.getElementById('slide-desc');
const avatarEl = document.getElementById('avatar-img');
const dots = document.querySelectorAll('.dot');
const nextBtn = document.getElementById('next-btn');

const tg = window.Telegram.WebApp;
tg.expand();

function updateSlide() {
    titleEl.textContent = slides[currentSlide].title;
    descEl.textContent = slides[currentSlide].desc;
    avatarEl.src = slides[currentSlide].avatar;
    
    dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === currentSlide);
    });

    if (currentSlide === slides.length - 1) {
        nextBtn.innerHTML = 'Empezar';
        nextBtn.classList.remove('circle-btn');
        nextBtn.classList.add('btn-start');
    }
}

async function authenticateAndLoad() {
    if (tg.initDataUnsafe?.user) {
        const user = tg.initDataUnsafe.user;
        document.getElementById('user-name').textContent = user.first_name;
        document.getElementById('tg-avatar').textContent = user.first_name.charAt(0).toUpperCase();
    }

    if (!tg.initData) return;

    try {
        const response = await fetch(`${API_BASE}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ init_data: tg.initData })
        });
        const data = await response.json();
        localStorage.setItem('access_token', data.access_token);
        loadFiles();
    } catch (error) {
        console.error('Auth error');
    }
}

async function loadFiles() {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    try {
        const response = await fetch(`${API_BASE}/files`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const files = await response.json();
        const container = document.getElementById('cloud-items');
        
        if (files.length > 0) {
            container.innerHTML = '';
        }
    } catch (error) {
        console.error('Fetch error');
    }
}

nextBtn.addEventListener('click', () => {
    if (currentSlide < slides.length - 1) {
        currentSlide++;
        updateSlide();
    } else {
        localStorage.setItem('onboarding_done', 'true');
        onboardingScreen.classList.remove('active');
        mainScreen.classList.add('active');
        authenticateAndLoad();
    }
});

function initApp() {
    const isFirstTime = !localStorage.getItem('onboarding_done');
    
    if (isFirstTime) {
        onboardingScreen.classList.add('active');
        mainScreen.classList.remove('active');
        updateSlide();
    } else {
        onboardingScreen.classList.remove('active');
        mainScreen.classList.add('active');
        authenticateAndLoad();
    }
}

initApp();