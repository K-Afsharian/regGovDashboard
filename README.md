# EPA Docket Downloader (Regulations.gov V4)

A modern, high-performance web dashboard for searching, filtering, and downloading regulatory documents from EPA pesticide dockets via the official Regulations.gov API.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)

## 🚀 Key Features

- **Direct EPA Search**: Instantly resolve pesticide names or exact Docket IDs (e.g., `EPA-HQ-OPP-2007-0469`).
- **Server-Side Performance**: Utilizes Regulations.gov v4 native pagination, sorting, and filtering for near-instant loading of large dockets.
- **Advanced Filtering**:
  - **Document Type**: Supporting & Related Material, Notices, Rules, etc.
  - **Date Range**: Filter results by Last 30 Days, 90 Days, or 1 Year.
  - **Status**: Live toggle for "Open For Comment" documents.
- **Interactive Comment Viewer**: Explore public feedback for specific documents directly within the dashboard.
- **Direct Download Queue**: Sequential, direct-to-browser downloads optimized for restricted work networks.
- **Secure Authentication**: API keys are stored only in your local browser's storage, never on a server.

## 🛠️ Tech Stack

- **Frontend**: React (TypeScript)
- **Build Tool**: Vite
- **Styling**: Vanilla CSS (Modern Slate & Indigo palette)
- **API**: Regulations.gov V4 OpenAPI

## 🏁 Getting Started

### Prerequisites
- Node.js (v18+)
- A [Regulations.gov API Key](https://open.regulations.gov/api-js/)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/regGovDashboard.git
   cd regGovDashboard
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```

## 📦 Deployment

This app is pre-configured for **Vercel**. Simply connect your GitHub repository to Vercel for automatic CI/CD.

## 📄 License

Internal Use / MIT - Developed for EPA Regulatory Data Pipelines.
