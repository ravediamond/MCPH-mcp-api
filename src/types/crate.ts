export enum CrateCategory {
    IMAGE = "image",
    CODE = "code",
    MARKDOWN = "markdown",
    JSON = "json",
    DATA = "data",
    BINARY = "binary",
    TODOLIST = "todolist",
    DIAGRAM = "diagram"
}

export interface CrateSharing {
    public: boolean;
    // You can extend this with more sharing options as needed
    // For example: teamId?: string; domains?: string[]; etc.
}

export interface Crate {
    id: string;
    title: string;
    description?: string;
    ownerId: string;
    createdAt: Date;
    ttlDays?: number;
    mimeType: string;
    category: CrateCategory;
    gcsPath: string;
    shared: CrateSharing;
    tags?: string[];
    searchField?: string;
    size: number;
    downloadCount: number;
    metadata?: Record<string, string>;
    // Optional compression-related fields
    compressed?: boolean;
    originalSize?: number;
    compressionMethod?: string;
    compressionRatio?: number;
}