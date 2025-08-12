(function () {
    'use strict';

    // --- Configuration ---
    const API_BASE_URL = new URL(window.location.origin + window.location.pathname + '/');
    const MERMAID_CONFIG = {
        startOnLoad: true,
        theme: "default",
        themeVariables: {
            fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif',
            fontSize: "16px",
            primaryColor: '#fff',
            primaryTextColor: '#333',
            primaryBorderColor: '#ccc',
            lineColor: '#666',
            secondaryColor: '#f9f9f9',
            tertiaryColor: '#e6e6e6'
        }
    };

    // --- Knockout View Models ---
    function createLogViewModel() {
        const self = {};
        self.logScopes = ko.observableArray([]);
        const logLevels = { 0: 'Trace', 1: 'Debug', 2: 'Info', 3: 'Warn', 4: 'Error', 5: 'Critical' };

        const formatTimestamp = (timestamp) => {
            const date = new Date(timestamp);
            return date.toLocaleTimeString() + '.' + date.getMilliseconds().toString().padStart(3, '0');
        };

        const createScope = (scope) => ({
            messageId: scope.MessageId,
            messageType: scope.MessageType || 'Unknown',
            entries: (scope.Entries || []).map(entry => ({
                timestamp: entry.Timestamp,
                formattedOffset: `${entry.Offset} ms`,
                logLevel: entry.LogLevel,
                logLevelText: logLevels[entry.LogLevel] || 'Unknown',
                message: entry.Message || ''
            })),
            expanded: ko.observable(true),
            formattedStart: formatTimestamp(scope.Started)
        });

        self.loadLogData = (rawData) => {
            const processedScopes = (rawData.Scopes || []).map(createScope).reverse();
            self.logScopes(processedScopes);
        };

        self.appendLogScope = (rawData) => {
            if (!rawData) return;
            const processedScope = createScope(rawData);
            self.logScopes.unshift(processedScope);
        };

        self.toggleScope = (scope) => scope.expanded(!scope.expanded());

        return self;
    }

    function createMainViewModel() {
        return {
            log: createLogViewModel(),
            lastError: ko.observable(),
            currentState: ko.observable()
        };
    }

    // --- Main Application Logic ---
    const App = {
        saga: {},
        viewModel: createMainViewModel(),

        init() {
            mermaid.initialize(MERMAID_CONFIG);
            ko.applyBindings(this.viewModel);

            this.setupEventListeners();
            this.pollForMermaidRender();
        },

        setupEventListeners() {
            // Expose actions to the global scope for HTML onclick handlers
            window.retry = () => this.publishMessage("RetryFaultedActivity", { retryState: this.saga.CurrentState });
            window.pause = () => this.publishMessage("PauseSaga");
            window.resume = () => this.publishMessage("ResumeSaga");
            window.remove = () => this.publishMessage("RemoveSaga");
            window.restart = () => this.publishMessage("RestartSaga");
            window.showLastError = () => console.error("Last Saga Error:", this.saga.LastError);

            // Server-Sent Events
            const evtSource = new EventSource(new URL('sse', API_BASE_URL));
            evtSource.onmessage = (event) => this.handleSseMessage(event);
            evtSource.onerror = (err) => console.error("EventSource failed:", err);
        },

        async fetchState() {
            try {
                const response = await fetch(new URL('state', API_BASE_URL));
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                return await response.json();
            } catch (error) {
                console.error('Failed to fetch initial state:', error);
                return null;
            }
        },

        publishMessage(typeName, value = {}) {
            const companyId = window.location.pathname.split("/").filter(Boolean).pop();
            value.CompanyId = companyId;

            fetch(new URL(`publish/${typeName}`, API_BASE_URL), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(value)
            }).catch(err => {
                console.error('Failed to publish message:', err);
                alert(`Failed to publish message: ${typeName}`);
            });
        },

        handleSseMessage(event) {
            const state = JSON.parse(event.data);
            console.log("Received state update:", state);

            this.updateSagaState(state);
            this.highlightCurrentState();
        },

        updateSagaState(state) {
            this.saga = state;
            this.viewModel.log.appendLogScope(state.LogScope);
            this.viewModel.lastError(state.LastError);
            this.viewModel.currentState(state.CurrentState);
        },

        highlightCurrentState() {
            if (!this.saga.CurrentState) return;

            const color = this.saga.LastError ? 'lightpink' : 'lightgreen';

            document.querySelectorAll('g.node rect').forEach(rect => {
                rect.style.fill = 'white';
            });

            const labelSpans = document.querySelectorAll('span.nodeLabel');
            labelSpans.forEach(span => {
                if (span.textContent.trim() === this.saga.CurrentState) {
                    const group = span.closest('g.node');
                    const rect = group?.querySelector('rect');
                    if (rect) rect.style.fill = color;
                }
            });
        },

        pollForMermaidRender() {
            const poll = setInterval(async () => {
                const svg = document.querySelector("#graph svg");
                if (svg && svg.getBBox && svg.getBBox().width > 0) {
                    clearInterval(poll);

                    const initialState = await this.fetchState();
                    if (initialState) {
                        this.updateSagaState(initialState);
                        this.viewModel.log.loadLogData(initialState.Log); // Initial full log load
                        this.highlightCurrentState();
                        this.enablePanAndZoom(svg);
                    }
                }
            }, 100);
        },

        enablePanAndZoom(svg) {
            if (svg.querySelector("g.zoom-container")) return;

            svg.style.width = "100%";
            svg.style.height = "100%";
            svg.style.display = "block";
            svg.style.cursor = "grab";
            svg.style.userSelect = "none";

            const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.classList.add("zoom-container");
            while (svg.firstChild) {
                g.appendChild(svg.firstChild);
            }
            svg.appendChild(g);

            const bbox = g.getBBox();
            let transform = {
                x: (svg.clientWidth - bbox.width) / 2 - bbox.x,
                y: (svg.clientHeight - bbox.height) / 2 - bbox.y,
                scale: 1
            };

            let isPanning = false;
            let startPoint = { x: 0, y: 0 };

            const updateTransform = () => {
                g.setAttribute("transform", `translate(${transform.x}, ${transform.y}) scale(${transform.scale})`);
            };

            const screenToSvg = (e) => {
                const p = svg.createSVGPoint();
                p.x = e.clientX;
                p.y = e.clientY;
                return p.matrixTransform(svg.getScreenCTM().inverse());
            };

            svg.addEventListener("mousedown", (e) => {
                isPanning = true;
                startPoint = screenToSvg(e);
                svg.style.cursor = "grabbing";
            });

            svg.addEventListener("mousemove", (e) => {
                if (!isPanning) return;
                const endPoint = screenToSvg(e);
                transform.x += endPoint.x - startPoint.x;
                transform.y += endPoint.y - startPoint.y;
                startPoint = endPoint;
                updateTransform();
            });

            const onMouseUpOrLeave = () => {
                isPanning = false;
                svg.style.cursor = "grab";
            };
            svg.addEventListener("mouseup", onMouseUpOrLeave);
            svg.addEventListener("mouseleave", onMouseUpOrLeave);

            svg.addEventListener("wheel", (e) => {
                e.preventDefault();
                const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
                const mousePoint = screenToSvg(e);

                transform.x = mousePoint.x - (mousePoint.x - transform.x) * zoomFactor;
                transform.y = mousePoint.y - (mousePoint.y - transform.y) * zoomFactor;
                transform.scale *= zoomFactor;

                updateTransform();
            }, { passive: false });

            updateTransform();
        }
    };

    // --- Initialization ---
    document.addEventListener("DOMContentLoaded", () => App.init());

})();
