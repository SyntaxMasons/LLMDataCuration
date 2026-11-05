import 'dotenv/config';
import { Sequelize, DataTypes } from 'sequelize';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── SQLite Database via Sequelize ───────────────────────────────────────────
export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'database.sqlite'),
  logging: false
});

// ─── User Model ───────────────────────────────────────────────────────────────
export const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  password: {
    type: DataTypes.STRING,   // bcrypt hash
    allowNull: false
  },
  role: {
    type: DataTypes.STRING,   // 'admin' | 'reviewer'
    allowNull: false,
    defaultValue: 'reviewer',
    validate: { isIn: [['admin', 'reviewer']] }
  },
  status: {
    type: DataTypes.STRING,   // 'active' | 'inactive'
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'inactive']] }
  }
}, {
  tableName: 'users',
  timestamps: true
});

// ─── Document Model ───────────────────────────────────────────────────────────
export const Document = sequelize.define('Document', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rawHtml: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,   // 'needs_extraction' | 'extracted' | 'reviewed'
    allowNull: false,
    defaultValue: 'needs_extraction'
  },
  createdById: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: User, key: 'id' }
  }
}, {
  tableName: 'documents',
  timestamps: true
});

// ─── QAPair Model ─────────────────────────────────────────────────────────────
export const QAPair = sequelize.define('QAPair', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  documentId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: Document, key: 'id' }
  },
  systemPrompt: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "You are a helpful technical support assistant. Answer the user's question accurately using only the provided HTML context."
  },
  prompt: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  answer: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  turns: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: []
  },
  status: {
    type: DataTypes.STRING,   // 'draft' | 'pending_approval' | 'approved' | 'rejected'
    allowNull: false,
    defaultValue: 'draft'
  },
  adminFeedback: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  reviewedById: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: User, key: 'id' }
  },
  approvedById: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: User, key: 'id' }
  }
}, {
  tableName: 'qa_pairs',
  timestamps: true
});

// ─── Associations ─────────────────────────────────────────────────────────────
Document.hasMany(QAPair, { foreignKey: 'documentId', as: 'qaPairs', onDelete: 'CASCADE' });
QAPair.belongsTo(Document, { foreignKey: 'documentId', as: 'document' });
Document.belongsTo(User, { foreignKey: 'createdById', as: 'creator' });
User.hasMany(QAPair, { foreignKey: 'reviewedById', as: 'reviewedQAs' });
User.hasMany(QAPair, { foreignKey: 'approvedById', as: 'approvedQAs' });
QAPair.belongsTo(User, { foreignKey: 'reviewedById', as: 'reviewer' });
QAPair.belongsTo(User, { foreignKey: 'approvedById', as: 'approver' });
User.hasMany(Document, { foreignKey: 'createdById', as: 'createdDocuments' });

// ─── Password Utilities ───────────────────────────────────────────────────────
const SALT_ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ─── Schema Migrations ────────────────────────────────────────────────────────
// `sequelize.sync()` creates new tables but never adds columns to an existing
// one, so older databases need a small additive migration.
async function migrateSchema() {
  const [columns] = await sequelize.query('PRAGMA table_info(documents)');
  const hasCreatedBy = columns.some(col => col.name === 'createdById');

  if (!hasCreatedBy) {
    await sequelize.query('ALTER TABLE documents ADD COLUMN createdById INTEGER REFERENCES users(id)');
    console.log('  ✓ Added documents.createdById column.');
  }
}

// ─── Database Init & Seed ─────────────────────────────────────────────────────
export async function initDatabase({ force = false } = {}) {
  await sequelize.sync({ force });
  await migrateSchema();

  // Read bootstrap credentials from environment
  const bootstrapUsers = [
    {
      username: process.env.BOOTSTRAP_ADMIN_USERNAME    || 'admin_bago',
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD    || 'Admin@2026!',
      role:     'admin'
    },
    {
      username: process.env.BOOTSTRAP_REVIEWER_USERNAME || 'masticn_user',
      password: process.env.BOOTSTRAP_REVIEWER_PASSWORD || 'Reviewer@2026!',
      role:     'reviewer'
    }
  ];

  for (const u of bootstrapUsers) {
    const existing = await User.findOne({ where: { username: u.username } });
    if (!existing) {
      const hashed = await hashPassword(u.password);
      await User.create({
        username: u.username,
        password: hashed,
        role:     u.role,
        status:   'active'
      });
      console.log(`  ✓ Seeded ${u.role}: ${u.username}`);
    }
  }

  // Seed sample document if no documents exist
  const docCount = await Document.count();
  if (docCount === 0) {
    const sampleHtml = `<div class="prose prose-invert max-w-none">
  <h2 class="text-2xl font-bold text-white mb-4 border-b border-gray-800 pb-2">System Architecture Overview</h2>
  <p class="mb-4">
    The core infrastructure is orchestrated via a central API Gateway which routes all incoming client
    requests to the appropriate microservices. The microservices operate in an isolated VPC.
  </p>
  <p class="mb-4">
    All read operations are cached heavily using a Redis cluster to reduce latency, while write operations
    are persisted directly to the primary PostgreSQL database cluster in a highly available configuration.
  </p>
  <div class="my-6 border border-gray-700 rounded-xl overflow-hidden bg-gray-800 p-2">
    <div class="bg-gray-900 rounded-lg p-4 flex justify-center items-center">
      <img src="https://placehold.co/800x400/1e293b/94a3b8?text=System+Architecture+Diagram"
           alt="System Architecture Diagram" class="max-w-full h-auto rounded shadow-sm opacity-90">
    </div>
    <p class="text-xs text-center text-gray-500 mt-2 italic">Figure 1.1: Request routing and data persistence flow.</p>
  </div>
  <p>
    Note: In the event of a Redis node failure, the application will fallback to direct database querying,
    potentially increasing response times by up to 300ms.
  </p>
</div>`;

    const reviewer = await User.findOne({ where: { role: 'reviewer' } });

    const doc = await Document.create({
      filename: 'kb_arch_092.html',
      title:    'System Architecture Overview',
      rawHtml:  sampleHtml,
      status:   'needs_extraction',
      createdById: reviewer ? reviewer.id : null
    });

    await QAPair.create({
      documentId:   doc.id,
      systemPrompt: "You are a helpful technical support assistant. Answer the user's question accurately using only the provided HTML context.",
      prompt:       'Based on the architecture overview, how are read and write operations handled?',
      answer:       'Read operations are cached heavily using a Redis cluster to reduce latency, while write operations are persisted directly to the primary PostgreSQL database cluster.',
      turns: [
        { role: 'user',      content: 'Based on the architecture overview, how are read and write operations handled?' },
        { role: 'assistant', content: 'Read operations are cached heavily using a Redis cluster to reduce latency, while write operations are persisted directly to the primary PostgreSQL database cluster.' }
      ],
      status:       'draft',
      reviewedById: reviewer ? reviewer.id : null
    });

    console.log('  ✓ Seeded sample document and Q&A pair.');
  }
}
