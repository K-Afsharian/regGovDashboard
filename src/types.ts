export interface Document {
  id: string;
  type: string;
  attributes: {
    agencyId: string;
    commentEndDate: string | null;
    commentStartDate: string | null;
    docketId: string;
    documentType: string;
    frDocNum: string;
    lastModifiedDate: string;
    objectId: string;
    openForComment: boolean;
    postedDate: string;
    subtype: string | null;
    title: string;
    withdrawn: boolean;
    fileFormats?: Array<{
      fileUrl: string;
      format: string;
      size: number;
    }>;
  };
}

export interface Docket {
  id: string;
  type: string;
  attributes: {
    agencyId: string;
    docketType: string;
    lastModifiedDate: string;
    objectId: string;
    title: string;
  };
}

export interface ApiResponse<T> {
  data: T[];
  included?: any[];
  meta: {
    totalElements: number;
    totalPages: number;
    pageNumber: number;
    pageSize: number;
    lastPage?: boolean;
  };
}
