// Hesitation Sensor - Core Physics Engine
export class AdvancedHesitationEngine {
    constructor() {
        this.score = 0;
        this.confidence = 0.0;
        this.status = "Analyzing Physics...";
        this.startTime = Date.now();
        this.lastX = null;
        this.lastY = null;
        this.lastTime = Date.now();
        this.lastScrollY = window.scrollY;
        this.isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        this.listeners = [];
    }

    onUpdate(callback) { this.listeners.push(callback); }

    triggerUpdate() {
        this.listeners.forEach(cb => cb({
            score: Math.round(this.score),
            confidence: parseFloat(this.confidence.toFixed(2)),
            status: this.status
        }));
    }

    init() {
        if (this.isMobile) {
            window.addEventListener('scroll', () => this.handleMobileScroll());
            window.addEventListener('touchstart', () => this.handleTouchStart());
            window.addEventListener('touchend', () => this.handleTouchEnd());
        } else {
            window.addEventListener('mousemove', (e) => this.handleDesktopMouse(e));
        }
        setInterval(() => this.checkIdleState(), 1000);
    }

    isTimeGuardActive() {
        return (Date.now() - this.startTime) < 4000;
    }

    handleDesktopMouse(e) {
        const now = Date.now();
        const dt = now - this.lastTime;
        if (dt < 25) return;

        if (this.lastX !== null && this.lastY !== null) {
            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;
            const distance = Math.sqrt(dx*dx + dy*dy);
            const speed = distance / dt;

            if (speed > 0.03 && speed < 0.35 && distance < 12) {
                this.score = Math.min(100, this.score + 3);
                this.confidence = Math.min(1.0, this.confidence + 0.05);
            } else if (speed > 1.5) {
                this.score = Math.max(0, this.score - 10);
                this.confidence = Math.min(1.0, this.confidence + 0.03);
            }
        }
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.lastTime = now;
        this.updatePsychState();
    }

    handleMobileScroll() {
        const now = Date.now();
        const currentScrollY = window.scrollY;
        const dScroll = Math.abs(currentScrollY - this.lastScrollY);
        const dt = now - this.lastTime;

        if (dt > 0) {
            const scrollSpeed = dScroll / dt;
            if (this.isTimeGuardActive()) {
                this.lastScrollY = currentScrollY;
                this.lastTime = now;
                return;
            }
            if (scrollSpeed > 0.01 && scrollSpeed < 0.25) {
                this.score = Math.min(100, this.score + 2.5);
                this.confidence = Math.min(1.0, this.confidence + 0.04);
            } else if (scrollSpeed > 1.8) {
                this.score = Math.max(0, this.score - 12);
            }
        }
        this.lastScrollY = currentScrollY;
        this.lastTime = now;
        this.updatePsychState();
    }

    handleTouchStart() { this.touchStartTime = Date.now(); }

    handleTouchEnd() {
        if (this.isTimeGuardActive()) return;
        const duration = Date.now() - this.touchStartTime;
        if (duration > 800 && duration < 3000) {
            this.score = Math.min(100, this.score + 10);
            this.confidence = Math.min(1.0, this.confidence + 0.10);
            this.updatePsychState();
        }
    }

    checkIdleState() {
        const elapsed = Date.now() - this.lastTime;
        if (elapsed > 2000) {
            if (this.isTimeGuardActive()) return;
            if (this.score > 40) {
                this.score = Math.min(100, this.score + 1.5);
                this.confidence = Math.max(0.0, this.confidence - 0.02);
            } else {
                this.score = Math.min(50, this.score + 0.5);
                this.confidence = Math.max(0.0, this.confidence - 0.03);
            }
            this.updatePsychState();
        }
    }

    updatePsychState() {
        if (this.score < 30) this.status = "Intentional / Evaluating";
        else if (this.score >= 30 && this.score < 65) this.status = "Deep Reading / Browsing";
        else if (this.score >= 65 && this.score < 85) this.status = "Hesitant (Price Analysis)";
        else this.status = "High Friction / Leaving Cart";
        this.triggerUpdate();
    }
}
